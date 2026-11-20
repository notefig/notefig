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
 *   on the next step that works; `auth-error`, `diverged` (the remote
 *   branch was rewritten: the way on is its version) and `paused` (back
 *   after a long time offline) wait for the user.
 * - `overwritten`: our text a merge replaced with the branch's, flagged
 *   until dismissed, whatever the state.
 * - `peers`: the other devices syncing the branch now. Sync is shared
 *   while there are any (a fast poll, a commit soon after each save), solo
 *   otherwise.
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

/** Where someone's caret is: a unit of the document (a paragraph, a list
 *  item's paragraph, a table row, a code block; `sync-editor.ts`) by its
 *  place among the document's units, and a character in it. */
export interface SyncCursor {
  /** `/`-separated path. */
  path: string;
  unit: number;
  offset: number;
}

/** Another device syncing the branch now (`sync-presence.ts`). */
export interface SyncPeer {
  deviceId: string;
  /** Its user's git name; null until read. */
  name: string | null;
  /** The colour it picked, from its heartbeat; null until read. */
  colour: string | null;
  /** Where it last typed or clicked; null until read, or if nowhere. */
  cursor: SyncCursor | null;
}

/** Our text a merge replaced with the branch's. */
export interface SyncOverwrite {
  /** `/`-separated path. */
  path: string;
  /** What was replaced; null when the whole file was (or isn't text). */
  text: string | null;
  /** Where this side is kept on this device, for `git show`: a ref to
   *  the file, or `<ref>:<path>`. Never pushed. */
  recovery: string;
}

/** A file another device deleted while it was open here: kept on this
 *  device until the user restores or closes it. */
export interface SyncDeletion {
  /** `/`-separated, in the workspace. */
  path: string;
  /** Who deleted it; null when the history doesn't say. */
  by: string | null;
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
  /** Newest last, at most `MAX_OVERWRITTEN`. */
  overwritten: SyncOverwrite[];
  peers: SyncPeer[];
  deleted: SyncDeletion[];
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
  | { type: "peers"; peers: SyncPeer[] }
  | { type: "deleted"; deleted: SyncDeletion[] }
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
  peers: [],
  deleted: [],
};

const RUNNING_CLEAR = { activity: "idle", fault: null, failures: 0, detail: null, summary: null } as const;
const MAX_OVERWRITTEN = 100;

/** Waiting on the user: nothing runs until `resume`. */
export function isStuck(state: SyncState): boolean {
  return state.fault === "auth-error" || state.fault === "diverged" || state.fault === "paused";
}

/** Someone else syncs the branch now: edits travel within seconds. */
export function isShared(state: SyncState): boolean {
  return state.peers.length > 0;
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
  // Unreachable, nobody is seen: back off from the solo poll.
  failed: (state, { fault, detail }) =>
    state.fault === "diverged" || state.fault === "paused"
      ? { ...state, activity: "idle", peers: [] }
      : { ...state, activity: "idle", fault, failures: state.failures + 1, detail, peers: [] },
  // Stopped until the user says go: nobody is watched meanwhile.
  diverged: (state, { detail }) => ({ ...state, activity: "idle", fault: "diverged", detail, summary: null, peers: [] }),
  paused: (state, { detail, summary }) => ({ ...state, activity: "idle", fault: "paused", detail, summary, peers: [] }),
  resume: (state) => ({ ...state, ...RUNNING_CLEAR, activity: state.activity }),
  overwritten: (state, { items }) =>
    items.length === 0 ? state : { ...state, overwritten: [...state.overwritten, ...items].slice(-MAX_OVERWRITTEN) },
  "dismiss-overwritten": (state) => (state.overwritten.length === 0 ? state : { ...state, overwritten: [] }),
  peers: (state, { peers }) => ({ ...state, peers }),
  deleted: (state, { deleted }) => ({ ...state, deleted }),
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
    // The flags outlast it: the text was replaced either way.
    const { overwritten } = state;
    return { ...INITIAL_SYNC_STATE, setup: event.setup, remote: event.remote, reason: event.reason ?? null, overwritten };
  }
  if (event.type === "dismiss-overwritten") return WHILE_ON[event.type](state, event);
  if (state.setup !== "on") return state;
  return (WHILE_ON[event.type] as (state: SyncState, event: SyncEvent) => SyncState)(state, event);
}

/** A slow poll: solo is one person, on one or more devices. */
export const POLL_MS = 12_000;
/** Commit once per sitting: after this long without a save, on window
 *  blur, or when the workspace closes. */
export const IDLE_COMMIT_MS = 180_000;
/** Shared: someone may be reading along, so look every second… */
export const SHARED_POLL_MS = 1_000;
/** …and commit this soon after the saves settle. */
export const SHARED_COMMIT_MS = 2_000;
const OFFLINE_MAX_MS = 120_000;
const THROTTLED_BASE_MS = 60_000;
const THROTTLED_MAX_MS = 600_000;

/** How long until the next poll (before jitter), backing off on faults. */
export function pollInterval(state: SyncState): number {
  const backoff = 2 ** Math.min(state.failures, 6);
  if (state.fault === "offline") return Math.min(POLL_MS * backoff, OFFLINE_MAX_MS);
  if (state.fault === "throttled") return Math.min(THROTTLED_BASE_MS * backoff, THROTTLED_MAX_MS);
  return isShared(state) ? SHARED_POLL_MS : POLL_MS;
}
