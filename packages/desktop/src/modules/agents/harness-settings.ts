/**
 * The harness settings as stored, seen as rows — every configured harness,
 * enabled or not — and the immutable edits the harnesses module applies to
 * them. No React, no storage: `core.harnesses` reads and writes through
 * these.
 */
import {
  isMaterialOverride,
  resolveEffectiveHarnesses,
  type CustomHarnessEntry,
  type HarnessDefinition,
  type HarnessDiscoveryResult,
  type HarnessOverride,
} from "@notefig/shared/agent";

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

export function toggleCustomEnabled(
  custom: CustomHarnessEntry[],
  id: string,
  enabled: boolean,
): CustomHarnessEntry[] {
  return custom.map((entry) =>
    entry.id === id ? { ...entry, enabled } : entry,
  );
}
