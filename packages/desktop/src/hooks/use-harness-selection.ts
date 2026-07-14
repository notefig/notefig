import { useMemo } from "react";
import type { HarnessDefinition } from "@metrists/shared/agent";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { useKv } from "@/utils/kv-store";

const DEFAULT_HARNESS_KEY = "default-harness";

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
  const storedId = kv.get(DEFAULT_HARNESS_KEY);
  const defaultHarness =
    BUILT_IN_HARNESSES.find((harness) => harness.id === storedId) ??
    BUILT_IN_HARNESSES[0];
  return {
    defaultHarness,
    setDefaultHarness: (harnessId: string) =>
      kv.set(DEFAULT_HARNESS_KEY, harnessId),
  };
}

/**
 * The harnesses worth offering in pickers: ones marked signed-in on this
 * machine (`auth:<id>`, written by the service on the first turn that
 * reaches the model). Before anything has ever signed in there are no
 * marks — fall back to all built-ins so a first run isn't a dead end.
 * A settings surface for enabling/configuring harnesses is planned
 * (MET-67 territory); this filter is the interim behavior.
 */
export function useActiveHarnesses(): HarnessDefinition[] {
  const kv = useKv<boolean>("agent");
  const activeIds = BUILT_IN_HARNESSES.filter((harness) =>
    kv.get(`auth:${harness.id}`),
  );
  return useMemo(
    () => (activeIds.length > 0 ? activeIds : BUILT_IN_HARNESSES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeIds.map((h) => h.id).join(",")],
  );
}
