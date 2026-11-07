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
import type { SyncCapabilities, SyncEvent } from "./sync-machine";
import type { SyncIncomingContent } from "./document-channel";

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
  | { status: "pushed"; head: string }
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
  /** One poll: the branch tip on the remote (null: no such branch) and
   *  how many `refs/notefig/v1/` refs there are. */
  poll(): Promise<SyncResult<{ remote: string | null; notefigRefs: number }>>;
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
  /** Push the branch, compare-and-swap against `remote` (null: create). */
  push(input: { remote: string | null }): Promise<SyncResult<SyncPushOutcome>>;
  /** Read and push access to a remote, before sync is on. */
  verify(input: {
    spec: SyncSessionSpec;
  }): Promise<SyncResult<SyncVerifyOutcome>>;
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
  documents: Pick<DocumentsApi, "write" | "editorText">;
  /** The workspace's files: rows for created and deleted files. */
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  fs: Pick<
    FileSystemSurface,
    "readFiles" | "readBinaryFiles" | "writeBinaryFiles" | "deleteFiles"
  >;
  /** Window blur, for a commit when the user leaves. Default: `window`. */
  onBlur?: (listener: () => void) => () => void;
  /** Default: global timers, `Math.random`. */
  setTimer?: (run: () => void, ms: number) => () => void;
  random?: () => number;
  now?: () => number;
}

export type SyncEngineFactory = (deps: SyncEngineDeps) => Promise<SyncEngine>;
