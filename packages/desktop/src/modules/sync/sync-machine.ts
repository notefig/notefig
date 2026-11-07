/**
 * The one sync state machine: pure, no timers, no I/O. Everything that
 * decides what sync does next (the engine's timers, the status bar, the
 * settings section) reads `syncCapabilities(state)`, never the raw state,
 * so a new state changes one table here rather than a guard in each
 * consumer.
 *
 * The state is three independent parts:
 *
 * - `level`: `off` (a regular workspace), `solo` (a sync workspace with no
 *   other live device), `shared` (another device's presence is seen).
 *   `shared` is reachable only through a `peers` event, which nothing but
 *   tests sends until presence lands (MET-272).
 * - `activity`: what the engine is doing right now (`committing`,
 *   `fetching`, `merging`, `pushing`) or `idle`.
 * - `fault`: why it is not simply in sync. `offline` and `throttled` are
 *   transient — the next step that succeeds clears them. `auth-error` and
 *   `diverged` (the failsafe) are sticky: only the user's `resume` or
 *   turning sync off leaves them.
 */

export type SyncLevel = "off" | "solo" | "shared";
export type SyncActivity =
  | "idle"
  | "committing"
  | "fetching"
  | "merging"
  | "pushing";
export type SyncFault = "offline" | "auth-error" | "throttled" | "diverged";

export interface SyncMachineState {
  level: SyncLevel;
  activity: SyncActivity;
  fault: SyncFault | null;
  /** Failed steps in a row, for back-off. */
  failures: number;
  /** A human-readable reason for the fault. */
  detail: string | null;
}

export type SyncEvent =
  /** sync.json is there: start at solo. */
  | { type: "enable" }
  /** sync.json is gone (or the workspace closes). */
  | { type: "disable" }
  /** Another device's live presence appeared or went away. */
  | { type: "peers"; present: boolean }
  /** The engine started a step. */
  | { type: "step"; activity: Exclude<SyncActivity, "idle"> }
  /** The steps in flight finished cleanly. */
  | { type: "settled" }
  /** A step failed for a reason sync recovers from on its own, or for
   *  missing access. */
  | {
      type: "failed";
      fault: "offline" | "auth-error" | "throttled";
      detail?: string;
    }
  /** Local and remote changed the same files and nothing may merge them
   *  yet (solo), or there is no common history: stop. */
  | { type: "diverged"; detail: string }
  /** The user asked to carry on (new token, or keep local files). */
  | { type: "resume" };

export const INITIAL_SYNC_STATE: SyncMachineState = {
  level: "off",
  activity: "idle",
  fault: null,
  failures: 0,
  detail: null,
};

const STICKY: ReadonlySet<SyncFault> = new Set(["auth-error", "diverged"]);

function isStuck(state: SyncMachineState): boolean {
  return state.fault !== null && STICKY.has(state.fault);
}

function whileOn(
  state: SyncMachineState,
  event: Exclude<SyncEvent, { type: "enable" } | { type: "disable" }>,
): SyncMachineState {
  switch (event.type) {
    case "peers": {
      const level = event.present ? "shared" : "solo";
      return level === state.level ? state : { ...state, level };
    }
    case "step":
      return isStuck(state) ? state : { ...state, activity: event.activity };
    case "settled":
      if (isStuck(state)) return { ...state, activity: "idle" };
      return { ...state, activity: "idle", fault: null, failures: 0, detail: null };
    case "failed":
      if (state.fault === "diverged") return { ...state, activity: "idle" };
      return {
        ...state,
        activity: "idle",
        fault: event.fault,
        failures: state.failures + 1,
        detail: event.detail ?? null,
      };
    case "diverged":
      return {
        ...state,
        activity: "idle",
        fault: "diverged",
        detail: event.detail,
      };
    case "resume":
      return { ...state, fault: null, failures: 0, detail: null };
  }
}

/** The next state. Unknown or meaningless events leave it unchanged. */
export function transition(
  state: SyncMachineState,
  event: SyncEvent,
): SyncMachineState {
  if (event.type === "disable") return INITIAL_SYNC_STATE;
  if (event.type === "enable") {
    return state.level === "off"
      ? { ...INITIAL_SYNC_STATE, level: "solo" }
      : state;
  }
  if (state.level === "off") return state;
  return whileOn(state, event);
}

/** What the status bar shows. */
export type SyncStatusKind =
  | "off"
  | "synced"
  | "committing"
  | "pulling"
  | "pushing"
  | "offline"
  | "throttled"
  | "auth-error"
  | "diverged";

/** What a sync workspace may and should do in a state. */
export interface SyncCapabilities {
  /** A sync workspace at all. */
  active: boolean;
  /** Local edits are committed and pushed. */
  commits: boolean;
  /** The remote is polled. */
  polls: boolean;
  /** How long to wait before the next poll (before jitter). */
  pollIntervalMs: number;
  /** How long typing must pause before a commit. */
  idleCommitMs: number;
  /** Shared-level behaviour (MET-271..273): leases, presence, the merge. */
  leases: boolean;
  presence: boolean;
  merges: boolean;
  status: SyncStatusKind;
  /** The user can resume from here. */
  canResume: boolean;
  detail: string | null;
}

/** Solo: a slow poll, commits after a pause (decision 8). */
export const SOLO_POLL_MS = 12_000;
/** Shared: a fast poll (with jitter), coalesced commits. */
export const SHARED_POLL_MS = 1_500;
export const SOLO_IDLE_COMMIT_MS = 4_000;
export const SHARED_IDLE_COMMIT_MS = 2_000;
const OFFLINE_MAX_MS = 120_000;
const THROTTLED_BASE_MS = 60_000;
const THROTTLED_MAX_MS = 600_000;

function pollInterval(state: SyncMachineState): number {
  const base = state.level === "shared" ? SHARED_POLL_MS : SOLO_POLL_MS;
  const backoff = 2 ** Math.min(state.failures, 6);
  if (state.fault === "offline") return Math.min(base * backoff, OFFLINE_MAX_MS);
  if (state.fault === "throttled") {
    return Math.min(THROTTLED_BASE_MS * backoff, THROTTLED_MAX_MS);
  }
  return base;
}

const ACTIVITY_STATUS: Record<SyncActivity, SyncStatusKind> = {
  idle: "synced",
  committing: "committing",
  fetching: "pulling",
  merging: "pulling",
  pushing: "pushing",
};

function statusOf(state: SyncMachineState): SyncStatusKind {
  if (state.level === "off") return "off";
  if (state.fault && (isStuck(state) || state.activity === "idle")) {
    return state.fault;
  }
  return ACTIVITY_STATUS[state.activity];
}

export function syncCapabilities(state: SyncMachineState): SyncCapabilities {
  const active = state.level !== "off";
  const running = active && !isStuck(state);
  const shared = running && state.level === "shared";
  return {
    active,
    commits: running,
    polls: running,
    pollIntervalMs: pollInterval(state),
    idleCommitMs:
      state.level === "shared" ? SHARED_IDLE_COMMIT_MS : SOLO_IDLE_COMMIT_MS,
    leases: shared,
    presence: shared,
    merges: shared,
    status: statusOf(state),
    canResume: active && isStuck(state),
    detail: state.detail,
  };
}
