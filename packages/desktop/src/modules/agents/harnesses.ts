/**
 * Harnesses as the rest of the app sees them — `core.harnesses`. Anything
 * that names a harness outside a session (a usage chart, a session list)
 * needs the same few answers, and this is where the agent subsystem gives
 * them, so no view carries a table of harness quirks of its own:
 *
 * - the configured definitions: built-ins merged with this machine's
 *   overrides and custom entries, read live from the harness settings KV;
 * - a label for any id, including one whose custom entry was deleted (its
 *   sessions keep the raw id);
 * - each harness's own handle (`harness(id)`), which does what is done to
 *   one harness — its definition, its settings edits, checking it is
 *   installed. What is done to all of them (`rescan()`) is each handle's,
 *   in turn;
 * - the views over all of them: what the pickers offer, what the welcome
 *   screen reports, what the settings list shows.
 *
 * The settings live in the `harness-settings` KV namespace, and nothing
 * outside this module reads or writes it.
 *
 * What a harness does differently at run time is its adapter's
 * (`core.harnessAdapters`).
 */
import {
  BUILT_IN_HARNESSES,
  CustomHarnessEntrySchema,
  HarnessOverrideSchema,
  describeProbedHarnesses,
  filterDiscoveredHarnesses,
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
  type CustomHarnessEntry,
  type HarnessDefinition,
  type HarnessDiscoveryResult,
  type HarnessOverride,
  type ProbedHarness,
} from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import { kvModule, type KvApi } from "@/modules/kv";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
  candidateProbeEntries,
  discoverHarnesses,
  type ProbeEntry,
  type Proc,
} from "./harness-discovery";
import {
  deriveHarnessSettingsRows,
  toggleCustomEnabled,
  toggleOverrideEnabled,
  type HarnessSettingsRow,
} from "./harness-settings";

/** One harness — `core.harnesses.harness(id)`. */
export interface Harness {
  readonly id: string;
  /** Its definition as configured: a built-in with this machine's override
   *  applied, or a custom entry. The stock built-in while the settings
   *  load; undefined for an id that names nothing (a deleted entry). */
  definition(): HarnessDefinition | undefined;
  /** Replace a built-in's per-machine edit; null goes back to stock. The
   *  install is checked again, since the command may have changed. False,
   *  with nothing written, for an override the schema rejects or an id
   *  that is no built-in. */
  saveOverride(override: HarnessOverride | null): Promise<boolean>;
  /** Add or replace the custom entry with this handle's id (the entry's own
   *  `id` is ignored), then check its install. False, with nothing
   *  written, for an entry the schema rejects. */
  saveCustom(entry: CustomHarnessEntry): Promise<boolean>;
  /** Offer it in the pickers or not. A built-in switched back to its
   *  natural state (on when found or never checked, off when not found)
   *  keeps no override, unless something else in it is overridden. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Delete a custom entry. A built-in can only be switched off. */
  remove(): Promise<void>;
  /** Check whether its binary is on this machine — its definition's
   *  `probeCommand`, else `command -v` on its spawn command — and record
   *  the verdict, so the pickers update live. Null when the check couldn't
   *  run (no shell on this platform, a timeout) or the id names no
   *  harness: that records nothing, since "couldn't check" must never read
   *  as "not installed". */
  rescan(): Promise<HarnessDiscoveryResult | null>;
}

export interface HarnessesApi {
  /** Built-ins with this machine's overrides and custom entries applied —
   *  every harness as configured, whether or not its binary was found.
   *  Built-ins alone until the settings have loaded. */
  configured(): HarnessDefinition[];
  /** A harness's display name: configured first, built-in next, the raw id
   *  last. */
  label(harnessId: string): string;
  /** The harness with this id; the handle reads its settings when used, so
   *  it holds for an entry added or edited after it was taken. */
  harness(harnessId: string): Harness;
  /** Rescan every built-in and every enabled custom entry (each handle's
   *  `rescan`). Null when the check couldn't run. */
  rescan(): Promise<Record<string, HarnessDiscoveryResult> | null>;
  /** What the pickers offer: configured and enabled, minus built-ins the
   *  install check affirmatively didn't find (an explicitly configured
   *  entry always shows). */
  pickable(): HarnessDefinition[];
  /** Every configured harness with its install check attached — the
   *  readiness view. Nothing is spawned; it reads the last verdicts. */
  probed(): ProbedHarness[];
  /** Every configured harness as the settings list shows it, the ones the
   *  pickers hide included. */
  settingsRows(): HarnessSettingsRow[];
}

export function createHarnesses({
  kv,
  proc,
}: {
  kv: Pick<KvApi, "collection" | "write">;
  proc: Proc;
}): HarnessesApi {
  const settings = kv.collection(HARNESS_SETTINGS_NAMESPACE);
  const overrides = () =>
    parseHarnessOverrides(settings.get(HARNESS_OVERRIDES_KEY)?.value);
  const custom = () =>
    parseCustomHarnessEntries(settings.get(HARNESS_CUSTOM_KEY)?.value);
  const discovery = () =>
    parseHarnessDiscovery(settings.get(HARNESS_DISCOVERY_KEY)?.value);
  const configured = () => resolveEffectiveHarnesses(overrides(), custom());
  const isBuiltIn = (harnessId: string) =>
    BUILT_IN_HARNESSES.some((harness) => harness.id === harnessId);

  /** Each edit reads the settings it changes once the last edit has
   *  landed, so two quick edits never write over each other. */
  let edits: Promise<unknown> = Promise.resolve();
  const edit = <T>(apply: () => Promise<T>): Promise<T> => {
    const next = edits.then(async () => {
      await settings.preload();
      return apply();
    });
    edits = next.catch(() => undefined);
    return next;
  };
  const writeOverrides = (next: Record<string, HarnessOverride>) =>
    kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY, next);
  const writeCustom = (next: CustomHarnessEntry[]) =>
    kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY, next);

  /** What checking `harnessId` runs — a disabled custom entry included,
   *  when it is asked for by name. */
  const probeEntryFor = (harnessId: string): ProbeEntry | undefined =>
    candidateProbeEntries(
      overrides(),
      custom().map((entry) => ({ ...entry, enabled: true })),
    ).find((entry) => entry.id === harnessId);

  const scans = createScanBatcher({
    proc,
    // Merged over the last verdicts: a check of one harness leaves the
    // others' standing.
    record: async (results) => {
      await settings.preload();
      await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_DISCOVERY_KEY, {
        ...discovery(),
        ...results,
      });
    },
  });

  const harness = (harnessId: string): Harness => {
    const handle: Harness = {
      id: harnessId,
      definition: () =>
        configured().find((harness) => harness.id === harnessId) ??
        BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId),
      async saveOverride(override) {
        if (!isBuiltIn(harnessId)) return false;
        const checked =
          override === null ? null : HarnessOverrideSchema.safeParse(override);
        if (checked && !checked.success) return false;
        await edit(() => {
          const next = { ...overrides() };
          if (checked) next[harnessId] = { ...checked.data, id: harnessId };
          else delete next[harnessId];
          return writeOverrides(next);
        });
        void handle.rescan();
        return true;
      },
      async saveCustom(entry) {
        const checked = CustomHarnessEntrySchema.safeParse({
          ...entry,
          id: harnessId,
        });
        if (!checked.success) return false;
        await edit(() => {
          const current = custom();
          const next = current.some((existing) => existing.id === harnessId)
            ? current.map((existing) =>
                existing.id === harnessId ? checked.data : existing,
              )
            : [...current, checked.data];
          return writeCustom(next);
        });
        void handle.rescan();
        return true;
      },
      setEnabled: (enabled) =>
        edit(() => {
          const current = custom();
          if (current.some((entry) => entry.id === harnessId)) {
            return writeCustom(toggleCustomEnabled(current, harnessId, enabled));
          }
          if (!isBuiltIn(harnessId)) return Promise.resolve();
          return writeOverrides(
            toggleOverrideEnabled(
              overrides(),
              harnessId,
              enabled,
              discovery()[harnessId]?.found !== false,
            ),
          );
        }),
      remove: () =>
        edit(() =>
          writeCustom(custom().filter((entry) => entry.id !== harnessId)),
        ),
      async rescan() {
        await settings.preload();
        const entry = probeEntryFor(harnessId);
        return entry ? scans.scan(entry) : null;
      },
    };
    return handle;
  };

  return {
    configured,
    label(harnessId) {
      return (
        configured().find((harness) => harness.id === harnessId)?.label ??
        BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId)?.label ??
        harnessId
      );
    },
    harness,
    async rescan() {
      await settings.preload();
      const ids = candidateProbeEntries(overrides(), custom()).map(
        (entry) => entry.id,
      );
      const verdicts = await Promise.all(ids.map((id) => harness(id).rescan()));
      if (verdicts.some((verdict) => verdict === null)) return null;
      return Object.fromEntries(
        verdicts.map((verdict) => [verdict!.harnessId, verdict!]),
      );
    },
    pickable: () =>
      filterDiscoveredHarnesses(configured(), overrides(), custom(), discovery()),
    probed: () => describeProbedHarnesses(overrides(), custom(), discovery()),
    settingsRows: () =>
      deriveHarnessSettingsRows(overrides(), custom(), discovery()),
  };
}

/**
 * Spawning a login shell is the expensive part of an install check, so
 * the checks asked for in one tick — `rescan()` asking every handle — run
 * as one script, and their verdicts are recorded in one write. Writes go
 * one after another, each over what the last one left.
 */
function createScanBatcher({
  proc,
  record,
}: {
  proc: Proc;
  record: (results: Record<string, HarnessDiscoveryResult>) => Promise<void>;
}) {
  let pending: {
    entry: ProbeEntry;
    resolve: (verdict: HarnessDiscoveryResult | null) => void;
  }[] = [];
  let writes: Promise<void> = Promise.resolve();

  const flush = async () => {
    const batch = pending;
    pending = [];
    const results = await discoverHarnesses(
      proc,
      batch.map((item) => item.entry),
    );
    if (results !== null) {
      writes = writes.then(() => record(results)).catch((error) => {
        console.warn("Recording harness install checks failed:", error);
      });
      await writes;
    }
    for (const item of batch) item.resolve(results?.[item.entry.id] ?? null);
  };

  return {
    scan(entry: ProbeEntry): Promise<HarnessDiscoveryResult | null> {
      return new Promise((resolve) => {
        if (pending.length === 0) queueMicrotask(() => void flush());
        pending.push({ entry, resolve });
      });
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    harnesses: HarnessesApi;
  }
}

/**
 * The launch scan is the module's boot: one install check of every harness
 * per app session. Where there is no shell (a browser) it comes back
 * "couldn't check" and records nothing; a failure is logged and never
 * fails startup — the last verdicts stand until a check succeeds.
 */
export const harnessesModule = defineModule({
  name: "harnesses",
  // Platform: an install check runs a shell script.
  needs: [platformModule, kvModule],
  register: (ctx) =>
    createHarnesses({ kv: ctx.use("kv"), proc: ctx.use("platform").proc }),
  boot: (harnesses) => {
    void harnesses.rescan().catch((error) => {
      console.warn("Startup harness discovery failed:", error);
    });
  },
});
