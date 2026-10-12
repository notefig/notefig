/**
 * A harness as this machine records it — `HarnessRow`, one per harness in
 * the `harnesses` collection — and every view over those rows: what the
 * pickers offer, what the welcome screen reports, what settings lists. No
 * React, no storage: `core.harnesses` and the hooks in `react.ts` read
 * through these, so a view computed synchronously and one computed from a
 * live query can't disagree.
 */
import {
  BUILT_IN_HARNESSES,
  describeProbedHarnesses,
  filterDiscoveredHarnesses,
  isMaterialOverride,
  resolveEffectiveHarnesses,
  type CustomHarnessEntry,
  type HarnessDefinition,
  type HarnessDiscoveryResult,
  type HarnessOverride,
  type ProbedHarness,
} from "@notefig/shared/agent";

/**
 * What this machine records about one harness. A built-in has a row once
 * there is something to record (an edit, an install check) and is shown
 * without one; a custom entry exists only as its row. Only the edit is
 * stored, never the definition it makes: a built-in's own defaults change
 * with the app, and an untouched field must follow them.
 */
export interface HarnessRow {
  /** The harness id: a built-in's, or a custom entry's `custom:<uuid>`. */
  id: string;
  /** A built-in's edit on this machine, its on/off switch included. */
  override?: HarnessOverride;
  /** A custom entry, whole. */
  custom?: CustomHarnessEntry;
  /** What the last install check found. */
  install?: HarnessDiscoveryResult;
  /** When the row was first written; custom entries list in this order. */
  createdAt: number;
}

/** The rows as the three settings the views are defined over. */
function settingsOf(rows: Iterable<HarnessRow>) {
  const overrides: Record<string, HarnessOverride> = {};
  const custom: CustomHarnessEntry[] = [];
  const discovery: Record<string, HarnessDiscoveryResult> = {};
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  for (const row of sorted) {
    if (row.override) overrides[row.id] = row.override;
    if (row.custom) custom.push(row.custom);
    if (row.install) discovery[row.id] = row.install;
  }
  return { overrides, custom, discovery };
}

/** Every enabled harness, built-ins with their edits applied, whether or
 *  not its binary was found. */
export function configuredHarnesses(
  rows: Iterable<HarnessRow>,
): HarnessDefinition[] {
  const { overrides, custom } = settingsOf(rows);
  return resolveEffectiveHarnesses(overrides, custom);
}

/** What the pickers offer: configured and enabled, minus built-ins the
 *  install check affirmatively didn't find (an explicitly configured entry
 *  always shows). */
export function pickableHarnesses(
  rows: Iterable<HarnessRow>,
): HarnessDefinition[] {
  const { overrides, custom, discovery } = settingsOf(rows);
  return filterDiscoveredHarnesses(
    resolveEffectiveHarnesses(overrides, custom),
    overrides,
    custom,
    discovery,
  );
}

/** Every configured harness with its install check attached — the
 *  readiness view. */
export function probedHarnesses(rows: Iterable<HarnessRow>): ProbedHarness[] {
  const { overrides, custom, discovery } = settingsOf(rows);
  return describeProbedHarnesses(overrides, custom, discovery);
}

/** Every harness as the settings list shows it, the ones the pickers hide
 *  included. */
export function harnessSettingsRows(
  rows: Iterable<HarnessRow>,
): HarnessSettingsRow[] {
  const { overrides, custom, discovery } = settingsOf(rows);
  return deriveHarnessSettingsRows(overrides, custom, discovery);
}

/** One harness's definition as configured, on or off: a built-in with its
 *  edit applied, or a custom entry; undefined for an id that names
 *  nothing (a deleted entry). */
export function harnessDefinition(
  rows: Iterable<HarnessRow>,
  harnessId: string,
): HarnessDefinition | undefined {
  return harnessSettingsRows(rows).find(
    (row) => row.definition.id === harnessId,
  )?.definition;
}

/** A harness's display name: as configured, else the raw id (a deleted
 *  entry's sessions keep it). */
export function harnessLabel(
  rows: Iterable<HarnessRow>,
  harnessId: string,
): string {
  return (
    harnessDefinition(rows, harnessId)?.label ??
    BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId)?.label ??
    harnessId
  );
}

export type HarnessSettingsRow = {
  definition: HarnessDefinition;
  origin: "builtin" | "overridden" | "custom";
  enabled: boolean;
  discovery?: HarnessDiscoveryResult;
};

/**
 * ALL configured harnesses — including ones the pickers hide (disabled, or
 * not found by discovery): the settings list exists to show what's hidden.
 * Reuses resolveEffectiveHarnesses for the merge by forcing every row
 * enabled, then re-annotating the real enabled state. Without an explicit
 * setting (no override row), a built-in that discovery affirmatively did
 * NOT find shows as OFF — mirroring the pickers, which hide it; flipping it
 * on writes an explicit override, which also pins it visible there.
 */
export function deriveHarnessSettingsRows(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
  discovery: Record<string, HarnessDiscoveryResult>,
): HarnessSettingsRow[] {
  const forcedOverrides = Object.fromEntries(
    Object.entries(overrides).map(([id, override]) => [
      id,
      { ...override, enabled: true },
    ]),
  );
  const forcedCustom = custom.map((entry) => ({ ...entry, enabled: true }));
  const customIds = new Set(custom.map((entry) => entry.id));

  return resolveEffectiveHarnesses(forcedOverrides, forcedCustom).map(
    (definition) => {
      const id = definition.id;
      const explicit = customIds.has(id)
        ? custom.find((entry) => entry.id === id)?.enabled
        : overrides[id]?.enabled;
      const enabled =
        explicit !== undefined ? explicit : discovery[id]?.found !== false;
      return {
        definition,
        // Enabled-only rows are the on/off switch, not a customization.
        origin: customIds.has(id)
          ? ("custom" as const)
          : overrides[id] && isMaterialOverride(overrides[id])
            ? ("overridden" as const)
            : ("builtin" as const),
        enabled,
        discovery: discovery[id],
      };
    },
  );
}

// Write helpers (immutable — the module writes the result).

/** Flip a built-in's enabled flag, preserving any materially-overridden
 *  fields. When the new state matches the natural default (found ⇒ on,
 *  not-found ⇒ off) and nothing else is overridden, the row is removed
 *  instead of kept — re-enabling a stock harness must leave no trace. */
export function toggleOverrideEnabled(
  overrides: Record<string, HarnessOverride>,
  id: string,
  enabled: boolean,
  naturalEnabled: boolean,
): Record<string, HarnessOverride> {
  const existing = overrides[id];
  if (
    enabled === naturalEnabled &&
    (!existing || !isMaterialOverride(existing))
  ) {
    if (!existing) return overrides;
    const next = { ...overrides };
    delete next[id];
    return next;
  }
  return { ...overrides, [id]: { ...(existing ?? { id, enabled }), enabled } };
}
