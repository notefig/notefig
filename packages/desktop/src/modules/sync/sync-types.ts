/**
 * The vocabulary between the sync module (always loaded, tiny), its
 * engine (loaded only for a sync workspace) and the sync worker. Types
 * only: importing this file loads nothing.
 */
import type { Hooks } from "@notefig/core";
import type { GitRemote } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { DocumentsApi } from "@/modules/documents";
import type { WorkspaceFiles } from "@/modules/files";
import type { SyncAuthor, SyncConfig } from "./sync-config";
import type { SyncPresenceSettings } from "./presence-identity";
import type { SyncCapabilities, SyncEvent } from "./sync-machine";
import type {
  SyncAgentActivity,
  SyncBlockPosition,
  SyncDocumentPort,
  SyncIncomingContent,
  SyncLeaseOutcome,
} from "./document-channel";
import type { GatedWrite } from "@/modules/write-gate";
import type { EditorsApi } from "@/modules/editors";
import type { AgentTaskRow } from "@notefig/shared/agent";
import type { LeaseHolder } from "./lease-rules";

/** An error that crossed the worker boundary, as data. `code` is a
 *  `GitErrorCode` when git raised it. */
export interface SyncStepError {
  code: string;
  message: string;
}

export type SyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SyncStepError };

/** What a worker session syncs. */
export interface SyncSessionSpec {
  /** The workspace root (native path): the repo's worktree. */
  workspacePath: string;
  /** `<ws>/.git`. */
  gitDir: string;
  remote: GitRemote;
  branch: string;
}

/** A worktree file the main thread must bring to a new commit. `path` is
 *  `/`-separated, relative to the workspace. */
export type SyncWrite =
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "binary"; bytes: Uint8Array }
  | { path: string; kind: "delete" };

/** Text a merge overwrote in one file (the loser's side of each
 *  overlap), or a whole file the remote won. */
export interface SyncOverwrite {
  /** `/`-separated, relative to the workspace. */
  path: string;
  fragments: string[];
  /** A binary file: the local version is only on the recovery ref. */
  binary?: boolean;
}

/** Why the failsafe stopped sync (decision 20). */
export type SyncFailsafeReason = "unrelated" | "validation" | "divergence";

export type SyncPullOutcome =
  /** The remote commit is already in the branch. */
  | { status: "up-to-date"; head: string }
  /** The branch moved to (or onto) the remote commit; the main thread
   *  applies `writes`. `skippedDirty`: files with uncommitted local edits
   *  that were left alone. `previous`: the branch tip before, which the
   *  held and skipped files' local edits are based on. `overwritten`: what
   *  the merge overwrote, kept on `recoveryRef`. */
  | {
      status: "fast-forward" | "rebased";
      head: string;
      previous: string;
      writes: SyncWrite[];
      skippedDirty: string[];
      overwritten: SyncOverwrite[];
      recoveryRef: string | null;
    }
  /** Solo: local and remote changed the same files; nothing moved. */
  | { status: "diverged"; paths: string[] }
  /** The failsafe: no common history, a merge that failed validation, or
   *  an offline divergence over the threshold. Nothing moved; the local
   *  branch is on `recoveryRef`. */
  | {
      status: "failsafe";
      reason: SyncFailsafeReason;
      paths: string[];
      detail: string;
      recoveryRef: string;
    };

/** One file's local edits merged onto the branch (`reconcile`). */
export type SyncReconcileOutcome =
  | {
      status: "merged";
      /** What the file should hold now. */
      write: SyncWrite;
      overwritten: SyncOverwrite | null;
      recoveryRef: string | null;
    }
  | { status: "failed"; reason: SyncFailsafeReason; detail: string };

/** Three texts merged (`mergeTexts`). */
export type SyncTextMergeOutcome =
  | { status: "merged"; content: string; overwritten: string[] }
  | { status: "failed"; reason: SyncFailsafeReason; detail: string };

export type SyncPushOutcome =
  /** `leases`: what the push acquired (atomically with the branch) and
   *  what the lease rule refused, when it carried acquisitions. */
  | { status: "pushed"; head: string; leases?: SyncLeasePushResult }
  | { status: "up-to-date"; head: string }
  /** The remote refused (it moved: re-poll and pull). */
  | { status: "rejected"; reason: string }
  /** No answer: it may or may not have landed. Re-poll. */
  | { status: "unknown" };

export interface SyncVerifyOutcome {
  /** The branch tip on the remote; null when the branch isn't there yet. */
  remoteHead: string | null;
  canPush: boolean;
}

/**
 * The sync worker's API. Every method answers with data, never throws
 * across the boundary. One session per worker (`open` first).
 */
export type SyncWorkerApi = {
  open(spec: SyncSessionSpec): Promise<SyncResult<{ head: string | null }>>;
  /** Commit local changes: only `paths` (`/`-separated); `"scan"`: what
   *  changed since the last commit (one listing, metadata in batches);
   *  `"all"`: a whole-worktree status. `oid` is null when nothing
   *  changed. */
  commit(input: {
    paths: SyncCommitScope;
    author: SyncAuthor;
    userName: string;
  }): Promise<SyncResult<{ oid: string | null; paths: string[] }>>;
  /** One poll: the branch tip on the remote (null: no such branch), how
   *  many `refs/notefig/v1/` refs there are, and the presence refs among
   *  them. */
  poll(): Promise<
    SyncResult<{
      remote: string | null;
      notefigRefs: number;
      presence: SyncRefTip[];
      /** Lease refs (`refs/notefig/v1/locks/…`), MET-273. */
      locks: SyncRefTip[];
    }>
  >;
  /** Publish this device's presence on its own ref, in a request of its
   *  own (never with a content push): a blob, CAS against `old` (null:
   *  create). */
  publishPresence(input: {
    ref: string;
    old: string | null;
    draft: SyncPresenceDraft;
  }): Promise<SyncResult<SyncPresencePublishOutcome>>;
  /** Delete this device's presence ref (CAS against `old`). */
  deletePresence(input: { ref: string; old: string }): Promise<SyncResult<{ deleted: boolean }>>;
  /** Fetch presence blobs by oid (one request for those not here yet) and
   *  map their positions onto the branch head. */
  readPresence(input: { refs: SyncRefTip[] }): Promise<SyncResult<SyncPresenceRead[]>>;
  /** Fetch `remote` and bring the branch to it: a fast-forward, or a
   *  rebase of the local commits. Solo refuses files both sides changed;
   *  `merge` (shared) merges them. */
  pull(input: {
    remote: string;
    /** Keep the local side, whole, of files both sides changed (the user
     *  resumed from `diverged`). */
    keepLocal?: boolean;
    /** Merge files both sides changed (the shared level). */
    merge?: boolean;
    /** The local commits were made offline: a divergence over the
     *  threshold is the failsafe. */
    offline?: boolean;
  }): Promise<SyncResult<SyncPullOutcome>>;
  /** Merge one file's local edits, made on `previous` and not committed
   *  (an editor's unsaved edits, a save that landed after the commit),
   *  onto the branch's version: markdown through the merge (the branch
   *  holds), anything else the branch's version wins. */
  reconcile(input: {
    path: string;
    previous: string;
    ours: { text: string } | { bytes: Uint8Array };
  }): Promise<SyncResult<SyncReconcileOutcome>>;
  /** A plain 3-way merge of markdown texts (theirs holds): an editor that
   *  changed while its merge ran is merged again from the snapshot. */
  mergeTexts(input: {
    path: string;
    base: string;
    ours: string;
    theirs: string;
  }): Promise<SyncResult<SyncTextMergeOutcome>>;
  /** Point a new local-only recovery ref at the branch tip. Never pushed. */
  saveRecovery(): Promise<SyncResult<{ ref: string }>>;
  /** The failsafe's "Accept all incoming": fetch `remote`, move the branch
   *  and index to it, and return the worktree writes that make the files
   *  match it. */
  resetToRemote(input: { remote: string }): Promise<SyncResult<{ head: string; writes: SyncWrite[] }>>;
  /** Push the branch, compare-and-swap against `remote` (null: create).
   *  With `acquire` (the shared level), the lease rule runs over what the
   *  pushed commits change, and the leases it grants (plus CAS deletes of
   *  stale leases taken over) go in the same atomic push. */
  push(input: {
    remote: string | null;
    acquire?: SyncAcquireInput;
  }): Promise<SyncResult<SyncPushOutcome>>;
  /** Read lease refs (fetching the blobs not here yet, in one request),
   *  map their blocks onto the branch head, and keep them as the worker's
   *  lease table: the merge's holder and the push's lease rule read it.
   *  `live` is the main thread's observation; `self` this device's id.
   *  An empty list clears the table (solo has no leases). */
  readLeases(input: {
    refs: Array<SyncRefTip & { live: boolean }>;
    self: string;
  }): Promise<SyncResult<SyncLeaseRead[]>>;
  /** Renew or release this device's own leases, without content: one
   *  atomic request of lease refs only (never with the branch). A null
   *  `payload` deletes the ref. */
  publishLeases(input: {
    updates: Array<{ ref: string; old: string | null; payload: SyncLeasePayload | null }>;
  }): Promise<SyncResult<SyncLeasePublishOutcome>>;
  /** The lease rule for a write that hasn't happened yet (an agent's): the
   *  blocks `content` changes against `current` (the document as the
   *  writer sees it), checked against the table mapped onto it. */
  planWrite(input: {
    path: string;
    current: string;
    content: string;
    holder: LeaseHolder;
  }): Promise<SyncResult<SyncWritePlan>>;
  /** Read and push access to a remote, before sync is on. */
  verify(input: {
    spec: SyncSessionSpec;
  }): Promise<SyncResult<SyncVerifyOutcome>>;
};

// --- Presence (MET-272) ------------------------------------------------------

/** One caret in a presence payload. `path` is `/`-separated, relative to
 *  the workspace; positions are relative to the payload's `commit`. */
export interface SyncPresenceCursor {
  path: string;
  anchor: SyncBlockPosition;
  head?: SyncBlockPosition;
}

/** One of a device's running agent sessions in its presence payload. */
export interface SyncPresenceAgent extends SyncAgentActivity {
  /** The document it is working on (`/`-separated, relative). */
  path?: string;
  /** Where in it, relative to the payload's `commit`, when known. */
  anchor?: SyncBlockPosition;
}

/**
 * `refs/notefig/v1/presence/<deviceId>` points at a blob holding this, as
 * JSON (decision 7). `seq` only makes a heartbeat move the ref; nothing in
 * it is a timestamp, because liveness is judged by the reader's own clock.
 */
export interface SyncPresencePayload {
  v: 1;
  user: { name: string; color: string };
  deviceId: string;
  /** The branch commit the positions are relative to. */
  commit: string | null;
  seq: number;
  /** The device's window has focus (a hint for the UI only). */
  focused: boolean;
  cursors: SyncPresenceCursor[];
  agents: SyncPresenceAgent[];
}

/** What the main thread hands the worker to publish: the payload minus
 *  `commit` (the worker stamps its branch head); an agent may name text it
 *  is writing (`snippets`), which the worker finds a block for. */
export interface SyncPresenceDraft
  extends Omit<SyncPresencePayload, "commit" | "agents"> {
  agents: Array<Omit<SyncPresenceAgent, "anchor"> & { snippets?: string[] }>;
}

/** A remote ref seen by a poll. */
export interface SyncRefTip {
  ref: string;
  oid: string;
}

/** Another device's presence, read by the worker, its positions mapped
 *  onto this clone's branch head (a block deleted since: dropped). */
export interface SyncPresenceRead {
  ref: string;
  oid: string;
  /** Null: not a presence payload this version reads. */
  payload: SyncPresencePayload | null;
}

export type SyncPresencePublishOutcome =
  | { status: "published"; oid: string }
  /** Our own ref wasn't at `old` (a stale CAS): re-poll, publish again. */
  | { status: "rejected" }
  | { status: "unknown" };

/**
 * Another device as the app shows it: its live presence, positions mapped
 * onto this clone's branch head, paths absolute.
 */
export interface SyncPeer {
  deviceId: string;
  name: string;
  color: string;
  focused: boolean;
  cursors: Array<{ path: string; anchor: SyncBlockPosition; head?: SyncBlockPosition }>;
  /** `holds`: blocks this agent leases (MET-273). */
  agents: Array<SyncAgentActivity & { path?: string; anchor?: SyncBlockPosition; holds?: number }>;
  /**
   * How many blocks this device's holders (the person and their agents)
   * lease right now (MET-273; 0 when none).
   */
  holds?: number;
}

// --- Leases (MET-273) --------------------------------------------------------

/**
 * `refs/notefig/v1/locks/<sha1(path)>/<holder>` points at a blob holding
 * this, as JSON: the blocks `holder` leases in `path`, as indexes relative
 * to `commit`. `seq` only makes a renewal move the ref.
 */
export interface SyncLeasePayload {
  v: 1;
  holder: LeaseHolder;
  /** `/`-separated, relative to the workspace. */
  path: string;
  commit: string;
  seq: number;
  blocks: number[];
}

/** One lease ref as the worker read it. `mapped`: each of the payload's
 *  blocks on the branch head (null: deleted since). */
export interface SyncLeaseRead {
  ref: string;
  oid: string;
  live: boolean;
  /** Null: not a lease payload this version reads. */
  payload: SyncLeasePayload | null;
  mapped: Array<number | null>;
}

/** An agent's write riding in this push: its blocks are attributed to it,
 *  the rest of what the commits change to the person. */
export interface SyncAgentClaim {
  holder: LeaseHolder;
  path: string;
  /** The text it wrote. */
  content: string;
}

export interface SyncAcquireInput {
  /** This device's person. */
  human: LeaseHolder;
  agents: SyncAgentClaim[];
}

/** A lease the push acquired or extended. `prev[i]`: the index of block
 *  `i` in the holder's previous payload (null: new); `touched[i]`: the
 *  change touched it. */
export interface SyncLeaseGrant {
  holder: LeaseHolder;
  path: string;
  ref: string;
  oid: string;
  payload: SyncLeasePayload;
  prev: Array<number | null>;
  touched: boolean[];
  /** Stale leases of others this took over (deleted in the same push). */
  tookOver: LeaseHolder[];
}

/** A live lease as the app shows it: blocks on this clone's head. */
export interface SyncLease {
  holder: LeaseHolder;
  /** Absolute path of the document. */
  path: string;
  blocks: number[];
  /** Held by this device (its person or one of its agents). */
  mine: boolean;
}

export interface SyncLeaseRefusal {
  holder: LeaseHolder;
  path: string;
  reason: "held" | "cap";
  holders: LeaseHolder[];
  /** Blocks (of the remote's version) that refused. */
  blocks: number[];
}

export interface SyncLeasePushResult {
  grants: SyncLeaseGrant[];
  refusals: SyncLeaseRefusal[];
}

export type SyncLeasePublishOutcome =
  | { status: "published"; oids: Record<string, string | null> }
  /** A ref wasn't at its `old` (atomic: nothing changed): re-poll. */
  | { status: "rejected" }
  | { status: "unknown" };

export type SyncWritePlan =
  | { granted: true; needed: number[] }
  | {
      granted: false;
      reason: "held" | "cap";
      holders: LeaseHolder[];
      /** Blocks (of `current`) that refused. */
      blocks: number[];
    };

/** Which files a commit looks at. */
export type SyncCommitScope = string[] | "scan" | "all";

/** A running worker. */
export interface SyncWorkerConnection {
  api: SyncWorkerApi;
  terminate(): void;
}

/** What turning sync on writes, minus the device id (made fresh). */
export interface SyncEnableInput {
  remote: string;
  branch: string;
  author?: SyncAuthor;
}

/** The engine as the module drives it. */
export interface SyncEngine {
  /** Run a sync cycle now (commit what changed, poll, pull, push). */
  syncNow(): Promise<void>;
  /** Carry on after a stop: the next pull keeps local files changed on
   *  both sides (the remote's version stays in history). */
  resume(): Promise<void>;
  /** The failsafe's "Accept all incoming": the local state goes to a
   *  recovery ref, then branch and files become the remote's. */
  acceptIncoming(): Promise<void>;
  /** The level changed (solo ↔ shared): re-time the poll. */
  levelChanged(): void;
  /** An agent's write through sync's lease gate (shared level): refused
   *  with the holders' names before anything is written, or written,
   *  pushed with its leases, and reported if it was merged. */
  gateWrite(write: GatedWrite, perform: () => Promise<void>): Promise<void>;
  /** Whether `blocks` of `path` are free of others' live leases. */
  checkLease(path: string, blocks: number[]): SyncLeaseOutcome;
  /** Stop timers and listeners, terminate the worker. */
  stop(): Promise<void>;
}

/** What the module hands the engine. */
export interface SyncEngineHost {
  workspacePath: string;
  config: SyncConfig;
  /** Sync was just turned on: the first commit takes every local change,
   *  not only what changed since the last commit. */
  fullScan?: boolean;
  /** The machine's events. */
  dispatch(event: SyncEvent): void;
  /** What the machine allows right now. */
  capabilities(): SyncCapabilities;
  /** Remote content reached a file (for open document channels). */
  delivered(path: string, event: SyncIncomingContent): void;
  /** A merge overwrote text (or a whole file the remote won). */
  overwritten(record: Omit<SyncOverwriteRecord, "id" | "at">): void;
  /** The live peers changed (MET-272). */
  presenceChanged(peers: readonly SyncPeer[]): void;
  /** The live leases changed (MET-273). */
  leasesChanged(leases: readonly SyncLease[]): void;
  /** The name and colour settings (sync.json's `presence`), read live:
   *  Settings → Sync can change them while sync runs. */
  presenceSettings(): SyncPresenceSettings | undefined;
  /** The open document channels' sync ends. */
  ports(): SyncDocumentPort[];
  /** The sync end of `path`'s channel, opened if it isn't. */
  openPort(path: string): SyncDocumentPort;
}

/** Something a merge overwrote, as the app shows it. */
export interface SyncOverwriteRecord {
  id: string;
  /** Absolute path of the file. */
  path: string;
  /** The loser's text of each overlap (empty for a binary). */
  fragments: string[];
  binary: boolean;
  /** The local-only ref that keeps the local version; null when the
   *  fragments themselves are all there was. */
  recoveryRef: string | null;
  /** The branch commit it happened on. */
  commit: string | null;
  /** When it was reported (ms). */
  at: number;
}

/** Everything the engine is built from. */
export interface SyncEngineDeps extends SyncEngineHost {
  worker: SyncWorkerConnection;
  hooks: Hooks;
  /** The adopting write (`core.documents`), with `source: "sync"`, and an
   *  open editor's text for merging its unsaved edits. */
  documents: Pick<DocumentsApi, "read" | "write" | "editorText">;
  /** The workspace's files: rows for created and deleted files. */
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  fs: Pick<
    FileSystemSurface,
    "readFiles" | "readBinaryFiles" | "writeBinaryFiles" | "deleteFiles"
  >;
  /** The live editors: the presence plugin attaches to the workspace's
   *  markdown editors at the shared level. */
  editors?: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** This device's agent sessions in the workspace (`core.agentStore`). */
  agentTasks?: () => readonly AgentTaskRow[];
  /** Window blur, for a commit when the user leaves. Default: `window`. */
  onBlur?: (listener: () => void) => () => void;
  /** Whether the window has focus. Default: `document.hasFocus()`. */
  isFocused?: () => boolean;
  /** The page is going away (quit, reload): a best-effort goodbye.
   *  Default: `pagehide`. */
  onPageHide?: (listener: () => void) => () => void;
  /** Default: global timers, `Math.random`. */
  setTimer?: (run: () => void, ms: number) => () => void;
  random?: () => number;
  now?: () => number;
}

export type SyncEngineFactory = (deps: SyncEngineDeps) => Promise<SyncEngine>;
