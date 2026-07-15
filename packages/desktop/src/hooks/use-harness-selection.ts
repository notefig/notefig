import { useMemo } from "react";
import type { HarnessDefinition } from "@metrists/shared/agent";
import {
  BUILT_IN_HARNESSES,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
} from "@metrists/shared/agent";
import { useKv } from "@/utils/kv-store";

const DEFAULT_HARNESS_KEY = "default-harness";
const HARNESS_SETTINGS_NAMESPACE = "harness-settings";
const OVERRIDES_KEY = "overrides";
const CUSTOM_KEY = "custom";

/**
 * The enabled, machine-configured harness list: built-ins merged with any
 * per-machine overrides, plus custom entries (MET-67). KV rows are schema-
 * validated before they can reach a spawn spec (kv.json is a plain file on
 * disk — corrupt or hand-edited rows are dropped, not spawned). Discovery
 * results are not consulted here (see `resolveEffectiveHarnesses`) —
 * they're telemetry for the settings UI, not a filter on what's offered.
 */
function useEffectiveHarnesses(): HarnessDefinition[] {
  const settings = useKv<unknown>(HARNESS_SETTINGS_NAMESPACE);
  const rawOverrides = settings.get(OVERRIDES_KEY);
  const rawCustom = settings.get(CUSTOM_KEY);
  return useMemo(
    () =>
      resolveEffectiveHarnesses(
        parseHarnessOverrides(rawOverrides),
        parseCustomHarnessEntries(rawCustom),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(rawOverrides), JSON.stringify(rawCustom)],
  );
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
 * override + custom) list, filtered to enabled ones. Before any settings
 * exist (fresh install) there are no overrides/custom rows, so this is just
 * all built-ins — a first run isn't a dead end. If every harness has been
 * explicitly disabled, fall back to showing all built-ins rather than an
 * empty picker.
 */
export function useActiveHarnesses(): HarnessDefinition[] {
  const effective = useEffectiveHarnesses();
  return effective.length > 0 ? effective : BUILT_IN_HARNESSES;
}
