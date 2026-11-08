/**
 * The one sync state machine: pure, no timers, no I/O. The engine, the
 * status bar and the sync popover all read the same `SyncState` snapshot,
 * replaced (never mutated) on each change.
 *
 * - `setup`: whether this device syncs. `unavailable` (no HTTPS remote, a
 *   detached HEAD), `off` (the project doesn't sync), `ask` (the project
 *   syncs and this device hasn't said yes or no), `declined` (not on this
 *   device: a local copy), `on`.
 * - `activity`: what the engine is doing right now.
 * - `fault`: why it isn't simply in sync. `offline` and `throttled` clear
 *   on the next step that works; `auth-error`, `diverged` (the failsafe)
 *   and `paused` (back after a long time offline) wait for the user.
 */

export type SyncSetup = "unavailable" | "off" | "ask" | "declined" | "on";
export type SyncActivity = "idle" | "committing" | "pulling" | "pushing";
export type SyncFault = "offline" | "throttled" | "auth-error" | "diverged" | "paused";

/** The remote and branch a workspace syncs with: the checked-out branch
 *  and its remote, read from the repo. */
export interface SyncRemote {
  url: string;
  branch: string;
}

/** What the offline-return question shows. */
export interface SyncReturnSummary {
  /** When this device last synced (ms since epoch); null if never. */
  since: number | null;
  /** `/`-separated paths changed here, and on the remote, since the
   *  common commit. */
  localFiles: string[];
  remoteFiles: string[];
  /** Authors of the remote's new commits. */
  people: string[];
}

/** Text a merge replaced with the holder's, flagged until dismissed. */
export interface SyncOverwrite {
  /** `/`-separated path. */
  path: string;
  /** What was lost; null for a binary file. */
  text: string | null;
}

export interface SyncState {
  setup: SyncSetup;
  /** Why sync can't run here (`setup: "unavailable"`). */
  reason: string | null;
  remote: SyncRemote | null;
  activity: SyncActivity;
  fault: SyncFault | null;
  /** Failed steps in a row, for back-off. */
  failures: number;
  /** A readable reason for the fault. */
  detail: string | null;
  /** Set while `paused`. */
  summary: SyncReturnSummary | null;
  overwritten: SyncOverwrite[];
}

export type SyncEvent =
  | { type: "setup"; setup: SyncSetup; remote: SyncRemote | null; reason?: string }
  | { type: "step"; activity: Exclude<SyncActivity, "idle"> }
  | { type: "settled" }
  | { type: "failed"; fault: "offline" | "throttled" | "auth-error"; detail: string }
  | { type: "diverged"; detail: string }
  | { type: "paused"; detail: string; summary: SyncReturnSummary }
  | { type: "resume" }
  | { type: "overwritten"; items: SyncOverwrite[] }
  | { type: "dismiss-overwritten" };

export const INITIAL_SYNC_STATE: SyncState = {
  setup: "off",
  reason: null,
  remote: null,
  activity: "idle",
  fault: null,
  failures: 0,
  detail: null,
  summary: null,
  overwritten: [],
};

const RUNNING_CLEAR = { activity: "idle", fault: null, failures: 0, detail: null, summary: null } as const;

/** Waiting on the user: nothing runs until `resume`. */
export function isStuck(state: SyncState): boolean {
  return state.fault === "auth-error" || state.fault === "diverged" || state.fault === "paused";
}

/** Whether the engine commits, polls and pushes. */
export function isRunning(state: SyncState): boolean {
  return state.setup === "on" && !isStuck(state);
}

type Handlers = {
  [K in Exclude<SyncEvent["type"], "setup">]: (state: SyncState, event: Extract<SyncEvent, { type: K }>) => SyncState;
};

/** While on: how each engine event moves the state. */
const WHILE_ON: Handlers = {
  step: (state, { activity }) => (isStuck(state) || state.activity === activity ? state : { ...state, activity }),
  settled: (state) => (isStuck(state) ? { ...state, activity: "idle" } : { ...state, ...RUNNING_CLEAR }),
  failed: (state, { fault, detail }) =>
    state.fault === "diverged" || state.fault === "paused"
      ? { ...state, activity: "idle" }
      : { ...state, activity: "idle", fault, failures: state.failures + 1, detail },
  diverged: (state, { detail }) => ({ ...state, activity: "idle", fault: "diverged", detail, summary: null }),
  paused: (state, { detail, summary }) => ({ ...state, activity: "idle", fault: "paused", detail, summary }),
  resume: (state) => ({ ...state, ...RUNNING_CLEAR, activity: state.activity }),
  overwritten: (state, { items }) => ({ ...state, overwritten: [...state.overwritten, ...items] }),
  "dismiss-overwritten": (state) => (state.overwritten.length === 0 ? state : { ...state, overwritten: [] }),
};

export function sameRemote(a: SyncRemote | null, b: SyncRemote | null): boolean {
  return a?.url === b?.url && a?.branch === b?.branch;
}

function sameSetup(state: SyncState, event: Extract<SyncEvent, { type: "setup" }>): boolean {
  return state.setup === event.setup && sameRemote(state.remote, event.remote) && state.reason === (event.reason ?? null);
}

/** The next state; an event that changes nothing returns `state` itself. */
export function transition(state: SyncState, event: SyncEvent): SyncState {
  if (event.type === "setup") {
    if (sameSetup(state, event)) return state;
    return { ...INITIAL_SYNC_STATE, setup: event.setup, remote: event.remote, reason: event.reason ?? null };
  }
  if (state.setup !== "on") return state;
  return (WHILE_ON[event.type] as (state: SyncState, event: SyncEvent) => SyncState)(state, event);
}

/** A slow poll: solo is one person, on one or more devices. */
export const POLL_MS = 12_000;
/** Commit once per sitting: after this long without a save, on window
 *  blur, or when the workspace closes. */
export const IDLE_COMMIT_MS = 180_000;
const OFFLINE_MAX_MS = 120_000;
const THROTTLED_BASE_MS = 60_000;
const THROTTLED_MAX_MS = 600_000;

/** How long until the next poll (before jitter), backing off on faults. */
export function pollInterval(state: SyncState): number {
  const backoff = 2 ** Math.min(state.failures, 6);
  if (state.fault === "offline") return Math.min(POLL_MS * backoff, OFFLINE_MAX_MS);
  if (state.fault === "throttled") return Math.min(THROTTLED_BASE_MS * backoff, THROTTLED_MAX_MS);
  return POLL_MS;
}
