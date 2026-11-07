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

export type SyncPullOutcome =
  /** The remote commit is already in the branch. */
  | { status: "up-to-date"; head: string }
  /** The branch moved to (or onto) the remote commit; the main thread
   *  applies `writes`. `skippedDirty`: files with uncommitted local edits
   *  that were left alone. */
  | {
      status: "fast-forward" | "rebased";
      head: string;
      writes: SyncWrite[];
      skippedDirty: string[];
    }
  /** Local and remote changed the same files; nothing moved. */
  | { status: "diverged"; paths: string[] }
  /** No common history (the branch was rewritten); nothing moved. */
  | { status: "unrelated" };

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
  /** Commit local changes: only `paths` (`/`-separated) when given, the
   *  whole worktree when null. `oid` is null when nothing changed. */
  commit(input: {
    paths: string[] | null;
    author: SyncAuthor;
    userName: string;
  }): Promise<SyncResult<{ oid: string | null; paths: string[] }>>;
  /** One poll: the branch tip on the remote (null: no such branch) and
   *  how many `refs/notefig/v1/` refs there are. */
  poll(): Promise<SyncResult<{ remote: string | null; notefigRefs: number }>>;
  /** Fetch `remote` and bring the branch to it (fast-forward, or a rebase
   *  of local commits that touch other files). */
  pull(input: { remote: string }): Promise<SyncResult<SyncPullOutcome>>;
  /** Push the branch, compare-and-swap against `remote` (null: create). */
  push(input: { remote: string | null }): Promise<SyncResult<SyncPushOutcome>>;
  /** Read and push access to a remote, before sync is on. */
  verify(input: {
    spec: SyncSessionSpec;
  }): Promise<SyncResult<SyncVerifyOutcome>>;
};

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
  /** Stop timers and listeners, terminate the worker. */
  stop(): Promise<void>;
}

/** What the module hands the engine. */
export interface SyncEngineHost {
  workspacePath: string;
  config: SyncConfig;
  /** The machine's events. */
  dispatch(event: SyncEvent): void;
  /** What the machine allows right now. */
  capabilities(): SyncCapabilities;
  /** Remote content reached a file (for open document channels). */
  delivered(path: string, event: SyncIncomingContent): void;
}

/** Everything the engine is built from. */
export interface SyncEngineDeps extends SyncEngineHost {
  worker: SyncWorkerConnection;
  hooks: Hooks;
  /** The adopting write (`core.documents`), with `source: "sync"`. */
  documents: Pick<DocumentsApi, "write">;
  /** The workspace's files: rows for created and deleted files. */
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  fs: Pick<FileSystemSurface, "readFiles" | "writeBinaryFiles" | "deleteFiles">;
  /** Window blur, for a commit when the user leaves. Default: `window`. */
  onBlur?: (listener: () => void) => () => void;
  /** Default: global timers, `Math.random`. */
  setTimer?: (run: () => void, ms: number) => () => void;
  random?: () => number;
}

export type SyncEngineFactory = (deps: SyncEngineDeps) => Promise<SyncEngine>;
