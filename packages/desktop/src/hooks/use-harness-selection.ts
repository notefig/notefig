import { useMemo } from "react";
import {
  BUILT_IN_HARNESSES,
  type HarnessDefinition,
  type ProbedHarness,
} from "@notefig/shared/agent";
import { useHarnesses } from "@/modules/agents/react";
import { useKv } from "@/modules/kv/react";
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
 * The pickable harness list (`core.harnesses.pickable()`): built-ins merged
 * with any per-machine overrides, plus custom entries (MET-67), minus
 * built-ins the startup scan didn't find (they'd just fail at spawn), while
 * explicitly configured entries always show.
 */
function useEffectiveHarnesses(): HarnessDefinition[] {
  return useHarnesses((harnesses) => harnesses.pickable());
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

/**
 * Every configured harness with the startup scan's verdict attached —
 * the readiness view, as opposed to `useActiveHarnesses`'s pickable view.
 * Nothing here spawns or connects: it reads the verdicts the launch scan
 * (the harnesses module's boot) already recorded, and stays correct as that scan
 * lands.
 *
 * Deliberately NOT tunnel-aware. The welcome screen runs before any
 * workspace exists, so there is no worker to ask; on web the local probe
 * can't run at all and every row simply reports "unknown", which the UI
 * renders as an absence rather than a claim.
 */
export function useProbedHarnesses(): ProbedHarness[] {
  return useHarnesses((harnesses) => harnesses.probed());
}

/** A harness's display name (`core.harnesses.label`), live: a renamed
 *  custom entry shows its new name without a reload. */
export function useHarnessLabel(harnessId: string): string {
  return useHarnessLabels()(harnessId);
}

/** The same lookup for many ids at once (a list keyed by harness). */
export function useHarnessLabels(): (harnessId: string) => string {
  return useHarnesses((harnesses) => (harnessId) => harnesses.label(harnessId));
}
