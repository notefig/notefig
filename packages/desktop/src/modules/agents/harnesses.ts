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
 *   one harness — checking it is installed. What is done to all of them
 *   (`rescan()`) is each handle's, in turn.
 *
 * What a harness does differently at run time is its adapter's
 * (`core.harnessAdapters`).
 */
import {
  BUILT_IN_HARNESSES,
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
  type HarnessDefinition,
  type HarnessDiscoveryResult,
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

/** One harness — `core.harnesses.harness(id)`. */
export interface Harness {
  readonly id: string;
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
  const configured = () => resolveEffectiveHarnesses(overrides(), custom());

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
        ...parseHarnessDiscovery(settings.get(HARNESS_DISCOVERY_KEY)?.value),
        ...results,
      });
    },
  });

  const harness = (harnessId: string): Harness => ({
    id: harnessId,
    async rescan() {
      await settings.preload();
      const entry = probeEntryFor(harnessId);
      return entry ? scans.scan(entry) : null;
    },
  });

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

export const harnessesModule = defineModule({
  name: "harnesses",
  // Platform: an install check runs a shell script.
  needs: [platformModule, kvModule],
  register: (ctx) =>
    createHarnesses({ kv: ctx.use("kv"), proc: ctx.use("platform").proc }),
});

declare module "@notefig/core" {
  interface CoreModules {
    "scan-harnesses": undefined;
  }
}

/**
 * One install check of every harness per app session, at launch. The
 * desktop shell runs it; the marketing site has no shell to check with.
 * A failed check is logged and never fails startup — the last verdicts
 * stand until the next one succeeds.
 */
export const scanHarnessesModule = defineModule({
  name: "scan-harnesses",
  needs: [harnessesModule],
  boot: (_api, ctx) => {
    void ctx
      .use("harnesses")
      .rescan()
      .catch((error) => {
        console.warn("Startup harness discovery failed:", error);
      });
  },
});
