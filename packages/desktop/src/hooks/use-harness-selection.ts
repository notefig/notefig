import { useMemo } from "react";
import type { HarnessDefinition } from "@metrists/shared/agent";
import {
  BUILT_IN_HARNESSES,
  filterDiscoveredHarnesses,
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
} from "@metrists/shared/agent";
import { useKv } from "@/utils/kv-store";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
} from "@/agent/harness-discovery";

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
  const effective = useEffectiveHarnesses();
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
  return effective.length > 0 ? effective : BUILT_IN_HARNESSES;
}
