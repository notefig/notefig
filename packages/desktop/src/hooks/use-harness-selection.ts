import { useMemo } from "react";
import type { HarnessDefinition } from "@notefig/shared/agent";
import {
  BUILT_IN_HARNESSES,
  filterDiscoveredHarnesses,
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
} from "@notefig/shared/agent";
import { useKv } from "@/utils/kv-store";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
} from "@/agent/harness-discovery";
import { useTunnelConnection } from "@/hooks/use-tunnel-connection";

/**
 * When paired with a remote worker, the machine that spawns harnesses is
 * the worker, not this browser — so the picker must reflect what the worker
 * advertised (web-side discovery is impossible; `runShellCommand` throws).
 * A null return means "not remote — leave the list alone".
 */
function useWorkerAvailableIds(): Set<string> | null {
  const state = useTunnelConnection();
  return useMemo(() => {
    if (state.status !== "connected") return null;
    return new Set(
      state.workerInfo.harnesses
        .filter((advert) => advert.available)
        .map((advert) => advert.id),
    );
  }, [state]);
}

const DEFAULT_HARNESS_KEY = "default-harness";

/**
 * The pickable harness list: built-ins merged with any per-machine
 * overrides, plus custom entries (MET-67), then filtered by discovery —
 * built-ins whose binary the startup scan didn't find are hidden (they'd
 * just fail at spawn), while explicitly configured entries always show
 * (see `filterDiscoveredHarnesses`). KV rows are schema-validated before
 * they can reach a spawn spec (kv.json is a plain file on disk — corrupt or
 * hand-edited rows are dropped, not spawned).
 */
function useEffectiveHarnesses(): HarnessDefinition[] {
  const settings = useKv<unknown>(HARNESS_SETTINGS_NAMESPACE);
  // Row values are stable references between KV mutations, so plain
  // reference deps suffice.
  const rawOverrides = settings.get(HARNESS_OVERRIDES_KEY);
  const rawCustom = settings.get(HARNESS_CUSTOM_KEY);
  const rawDiscovery = settings.get(HARNESS_DISCOVERY_KEY);
  return useMemo(() => {
    const overrides = parseHarnessOverrides(rawOverrides);
    const custom = parseCustomHarnessEntries(rawCustom);
    return filterDiscoveredHarnesses(
      resolveEffectiveHarnesses(overrides, custom),
      overrides,
      custom,
      parseHarnessDiscovery(rawDiscovery),
    );
  }, [rawOverrides, rawCustom, rawDiscovery]);
}

/**
 * Harness choice for the "new session" affordances. New sessions start on
 * the default harness without asking; picking a different one from the
 * adjacent dropdown both starts on it and remembers it as the new default
 * (per machine, KV-backed).
 */
export function useDefaultHarness(): {
  defaultHarness: HarnessDefinition;
  setDefaultHarness: (harnessId: string) => void;
} {
  const kv = useKv<string>("agent");
  const effective = useActiveHarnesses();
  const storedId = kv.get(DEFAULT_HARNESS_KEY);
  const defaultHarness =
    effective.find((harness) => harness.id === storedId) ??
    effective[0] ??
    BUILT_IN_HARNESSES[0];
  return {
    defaultHarness,
    setDefaultHarness: (harnessId: string) =>
      kv.set(DEFAULT_HARNESS_KEY, harnessId),
  };
}

/**
 * The harnesses worth offering in pickers: the effective (built-in +
 * override + custom) list, minus built-ins discovery didn't find. Before
 * any settings or scan results exist (fresh install, first frames) this is
 * just all built-ins — a first run isn't a dead end. If the list comes out
 * empty (everything disabled, or nothing installed at all), fall back to
 * showing all built-ins rather than an empty picker — each still names its
 * install/sign-in hint on failure.
 */
export function useActiveHarnesses(): HarnessDefinition[] {
  const effective = useEffectiveHarnesses();
  const workerIds = useWorkerAvailableIds();
  return useMemo(() => {
    const base = effective.length > 0 ? effective : BUILT_IN_HARNESSES;
    // Remote: intersect with what the worker actually has. If that leaves
    // nothing (worker has none of our known harnesses), show the worker's
    // list anyway is impossible — fall back to `base` so the picker isn't a
    // dead end; a spawn will fail with the worker's own error.
    if (!workerIds) return base;
    const filtered = base.filter((harness) => workerIds.has(harness.id));
    return filtered.length > 0 ? filtered : base;
  }, [effective, workerIds]);
}
