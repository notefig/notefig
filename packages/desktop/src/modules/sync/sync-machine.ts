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
 *   other live device), `shared` (someone else is writing). Two inputs
 *   make it shared: `peers` (another device's live presence, which
 *   MET-272's presence sends through `WorkspaceSync.setPeersPresent`) and
 *   `contention` (the remote moved under our own commits — a plain-git
 *   push, another device, offline edits — so the next pull has to merge;
 *   the engine sends it and clears it after a quiet spell). Solo never
 *   merges: only a shared level does.
 * - `activity`: what the engine is doing right now (`committing`,
 *   `fetching`, `merging`, `pushing`) or `idle`.
 * - `fault`: why it is not simply in sync. `offline` and `throttled` are
 *   transient — the next step that succeeds clears them. `auth-error` and
 *   `diverged` (a wrong branch checked out, a solo stop) are sticky: only
 *   the user's `resume` or turning sync off leaves them. `failsafe`
 *   (decision 20) is sticky too, and resume doesn't leave it: the user
 *   accepts all incoming (`recovered`) or turns sync off.
 */

export type SyncLevel = "off" | "solo" | "shared";
export type SyncActivity =
  | "idle"
  | "committing"
  | "fetching"
  | "merging"
  | "pushing";
export type SyncFault =
  | "offline"
  | "auth-error"
  | "throttled"
  | "diverged"
  | "failsafe";

/** Why the failsafe stopped sync, and where the local state was put. */
export interface SyncFailsafe {
  reason: "unrelated" | "validation" | "divergence";
  /** The local-only ref the local branch was saved to, before stopping. */
  recoveryRef: string;
  paths: string[];
}

export interface SyncMachineState {
  level: SyncLevel;
  /** Another device's live presence is seen (MET-272). */
  peers: boolean;
  /** The remote moved under our own commits recently. */
  contended: boolean;
  failsafe: SyncFailsafe | null;
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
  /** Someone else's commits reached the branch under ours (or that went
   *  quiet again). */
  | { type: "contention"; active: boolean }
  /** The failsafe: the local state is saved; the user chooses. */
  | { type: "failsafe"; failsafe: SyncFailsafe; detail: string }
  /** The user accepted all incoming: the failsafe is over. */
  | { type: "recovered" }
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
  peers: false,
  contended: false,
  failsafe: null,
  activity: "idle",
  fault: null,
  failures: 0,
  detail: null,
};

const STICKY: ReadonlySet<SyncFault> = new Set(["auth-error", "diverged", "failsafe"]);

function isStuck(state: SyncMachineState): boolean {
  return state.fault !== null && STICKY.has(state.fault);
}

/** `state` with the level its inputs call for. */
function leveled(state: SyncMachineState): SyncMachineState {
  const level = state.peers || state.contended ? "shared" : "solo";
  return level === state.level ? state : { ...state, level };
}

type OnEvent = Exclude<SyncEvent, { type: "enable" } | { type: "disable" }>;
type Handlers = {
  [K in OnEvent["type"]]: (
    state: SyncMachineState,
    event: Extract<OnEvent, { type: K }>,
  ) => SyncMachineState;
};

const idle = (state: SyncMachineState): SyncMachineState => ({ ...state, activity: "idle" });

/** One handler per event, while sync is on. */
const ON: Handlers = {
  peers: (state, { present }) =>
    state.peers === present ? state : leveled({ ...state, peers: present }),
  contention: (state, { active }) =>
    state.contended === active ? state : leveled({ ...state, contended: active }),
  step: (state, { activity }) => (isStuck(state) ? state : { ...state, activity }),
  settled: (state) =>
    isStuck(state)
      ? idle(state)
      : { ...state, activity: "idle", fault: null, failures: 0, detail: null },
  failed: (state, { fault, detail }) =>
    state.fault === "diverged" || state.fault === "failsafe"
      ? idle(state)
      : { ...state, activity: "idle", fault, failures: state.failures + 1, detail: detail ?? null },
  diverged: (state, { detail }) =>
    state.fault === "failsafe" ? idle(state) : { ...state, activity: "idle", fault: "diverged", detail },
  resume: (state) =>
    state.fault === "failsafe" ? state : { ...state, fault: null, failures: 0, detail: null },
  failsafe: (state, { failsafe, detail }) => ({
    ...state,
    activity: "idle",
    fault: "failsafe",
    failsafe,
    detail,
  }),
  recovered: (state) => ({ ...state, fault: null, failsafe: null, failures: 0, detail: null }),
};

function whileOn(state: SyncMachineState, event: OnEvent): SyncMachineState {
  const handle = ON[event.type] as (s: SyncMachineState, e: OnEvent) => SyncMachineState;
  return handle(state, event);
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
  | "diverged"
  | "failsafe";

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
  /** While typing goes on, commit at least this often (null: only after a
   *  pause). Shared coalesces commits to one per few seconds. */
  commitMaxWaitMs: number | null;
  /** Shared-level behaviour (MET-271..273): leases, presence, the merge. */
  leases: boolean;
  presence: boolean;
  merges: boolean;
  status: SyncStatusKind;
  /** The user can resume from here. */
  canResume: boolean;
  /** Stopped by the failsafe: offer "Accept all incoming" or "Turn sync
   *  off". */
  failsafe: SyncFailsafe | null;
  detail: string | null;
}

/** Solo: a slow poll, commits after a pause (decision 8). */
export const SOLO_POLL_MS = 12_000;
/** Shared: a fast poll (with jitter), coalesced commits. */
export const SHARED_POLL_MS = 1_500;
export const SOLO_IDLE_COMMIT_MS = 4_000;
export const SHARED_IDLE_COMMIT_MS = 2_000;
/** Shared: at most one commit per this long while typing goes on. */
export const SHARED_COMMIT_MAX_WAIT_MS = 3_000;
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
    commitMaxWaitMs: state.level === "shared" ? SHARED_COMMIT_MAX_WAIT_MS : null,
    leases: shared,
    presence: shared,
    merges: shared,
    status: statusOf(state),
    canResume: active && isStuck(state) && state.fault !== "failsafe",
    failsafe: active ? state.failsafe : null,
    detail: state.detail,
  };
}
