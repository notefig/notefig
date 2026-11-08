import type {
  add as igAdd,
  branch as igBranch,
  checkout as igCheckout,
  commit as igCommit,
  init as igInit,
  listBranches as igListBranches,
  log as igLog,
  remove as igRemove,
  resetIndex as igResetIndex,
} from "isomorphic-git";

/**
 * The repo a service instance operates on, bound once at construction — a
 * worktree plus an explicit gitdir, never inferred from each other. A
 * workspace can hold two repos over one worktree (the user's `<ws>/.git`
 * and the app's `<ws>/.notefig/.git`); an inferred or per-call gitdir let
 * callers silently operate on the wrong repo.
 */
export interface GitRepoRef {
  /** Worktree root (isomorphic-git's `dir`). */
  repoPath: string;
  /** Git directory (isomorphic-git's `gitdir`). */
  gitDir: string;
}

type GitOpInput<T> = Omit<T, "fs" | "dir" | "gitdir">;

type AddParams = Parameters<typeof igAdd>[0];
type BranchParams = Parameters<typeof igBranch>[0];
type CheckoutParams = Parameters<typeof igCheckout>[0];
type CommitParams = Parameters<typeof igCommit>[0];
type InitParams = Parameters<typeof igInit>[0];
type ListBranchesParams = Parameters<typeof igListBranches>[0];
type LogParams = Parameters<typeof igLog>[0];
type RemoveParams = Parameters<typeof igRemove>[0];
type ResetIndexParams = Parameters<typeof igResetIndex>[0];

export type GitChangeType =
  "added" | "modified" | "deleted" | "renamed" | "typechange";

export type GitErrorCode =
  | "AuthRequired"
  | "AuthFailed"
  | "NotFastForward"
  | "MergeRequired"
  | "LockUnavailable"
  | "RepoNotFound"
  | "UnsupportedOperation"
  | "CorruptRepository"
  | "InvalidInput"
  /** The remote could not be reached, timed out, or answered with a 5xx. */
  | "Network"
  /** The remote rate-limited the request (HTTP 429). Back off. */
  | "Throttled"
  /** The remote reported an error of its own (an `ERR` packet, a malformed reply). */
  | "RemoteError"
  /**
   * A push was sent but its reply never arrived (transport failure,
   * timeout, a 5xx, a cut-off reply). The refs may or may not have moved:
   * re-read them (`listRemoteRefs`) before deciding anything.
   */
  | "PushOutcomeUnknown";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly cause?: unknown;

  constructor(code: GitErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.cause = cause;
  }
}

export interface GitFileChange {
  path: string;
  type: GitChangeType;
  oldPath?: string;
}

export type GitHostStatResult =
  | {
      exists: false;
      isFile: false;
      isDir: false;
    }
  | {
      exists: true;
      isFile: boolean;
      isDir: boolean;
      size: number;
      mode: number;
      mtimeMs: number;
    };

export type GitHostLStatResult =
  | {
      exists: false;
      isFile: false;
      isDir: false;
      isSymbolicLink: false;
    }
  | {
      exists: true;
      isFile: boolean;
      isDir: boolean;
      isSymbolicLink: boolean;
      size: number;
      mode: number;
      mtimeMs: number;
    };

export interface GitHostDirEntry {
  name: string;
  isFile: boolean;
  isDir: boolean;
  isSymbolicLink: boolean;
}

export interface RepoStatus {
  repoPath: string;
  currentBranch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  conflicts: string[];
  ahead?: number;
  behind?: number;
}

export interface GitStorageHost {
  readFile(path: string): Promise<Uint8Array>;
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>;
  renameAtomic(from: string, to: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  stat(path: string): Promise<GitHostStatResult>;
  lstat(path: string): Promise<GitHostLStatResult>;
  readDir(path: string): Promise<GitHostDirEntry[]>;
  createDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  readLink(path: string): Promise<string>;
  createSymlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  lock(name: string): Promise<void>;
  unlock(name: string): Promise<void>;
}

export type GitAddInput = GitOpInput<AddParams>;
export type GitInitInput = GitOpInput<InitParams>;
export type GitUnstageInput = GitOpInput<ResetIndexParams>;
export type GitRemoveInput = GitOpInput<RemoveParams>;
export type GitCommitInput = GitOpInput<CommitParams>;
export type GitAddAllAndCommitInput = {
  message?: string;
  author: NonNullable<CommitParams["author"]>;
  committer?: CommitParams["committer"];
};
export type GitRevertCommitInput = {
  oid: string;
  author: NonNullable<CommitParams["author"]>;
  committer?: CommitParams["committer"];
  message?: string;
};
export type GitListBranchesInput = GitOpInput<ListBranchesParams>;
export type GitCreateBranchInput = GitOpInput<BranchParams>;
export type GitSwitchBranchInput = GitOpInput<
  Pick<CheckoutParams, "ref" | "force" | "track" | "remote">
>;
export type GitCheckoutPathsInput = GitOpInput<
  Pick<
    CheckoutParams,
    "ref" | "filepaths" | "force" | "noCheckout" | "noUpdateHead"
  >
>;
export type GitLogInput = GitOpInput<LogParams>;
export type GitReadTextFileInput = {
  /** Commit oid or ref to read the file at. */
  ref: string;
  filepath: string;
};

export interface GitService {
  init(input?: GitInitInput): ReturnType<typeof igInit>;
  status(): Promise<RepoStatus>;
  add(input: GitAddInput): ReturnType<typeof igAdd>;
  remove(input: GitRemoveInput): ReturnType<typeof igRemove>;
  unstage(input: GitUnstageInput): ReturnType<typeof igResetIndex>;
  commit(input: GitCommitInput): ReturnType<typeof igCommit>;
  addAllAndCommit(input: GitAddAllAndCommitInput): Promise<string | null>;
  revertCommit(input: GitRevertCommitInput): Promise<string | null>;
  abortRevert(): Promise<void>;
  listBranches(input: GitListBranchesInput): ReturnType<typeof igListBranches>;
  createBranch(input: GitCreateBranchInput): ReturnType<typeof igBranch>;
  switchBranch(input: GitSwitchBranchInput): ReturnType<typeof igCheckout>;
  checkoutPaths(input: GitCheckoutPathsInput): ReturnType<typeof igCheckout>;
  log(input: GitLogInput): ReturnType<typeof igLog>;
  /** Read a text file's content as of a given ref/commit (for history diff/restore). */
  readTextFile(input: GitReadTextFileInput): Promise<string>;

  // ── Remote operations (smart HTTP; need a `GitHttpClient`) ─────────────

  /**
   * The remote's refs under any of `prefixes` (all when empty), from one
   * ref advertisement: one request.
   */
  listRemoteRefs(
    remote: GitRemote,
    prefixes: string[],
  ): Promise<GitRemoteRef[]>;
  /**
   * Fetch exactly the named remote refs (their objects, nothing else) and
   * optionally point local refs at them. Each ref whose objects aren't
   * already present costs two requests (advertisement, then pack); a ref
   * given with an `oid` that's already local costs none.
   */
  fetchRefs(
    remote: GitRemote,
    refs: GitFetchRef[],
    options?: GitFetchRefsOptions,
  ): Promise<GitFetchRefsResult>;
  /**
   * One receive-pack request updating several refs, each a compare-and-swap
   * against its `old` value (`ZERO_OID` = must not exist; `new` = `ZERO_OID`
   * deletes). Per-ref rejections are results, not errors.
   */
  pushRefs(
    remote: GitRemote,
    updates: GitRefUpdate[],
    options?: GitPushRefsOptions,
  ): Promise<GitPushRefsResult>;

  // ── Local plumbing ─────────────────────────────────────────────────────

  /** A local ref's oid, or null when it doesn't exist. */
  readRef(ref: string): Promise<string | null>;
  /** Point a local ref at any object (a commit or a bare blob). */
  writeRef(input: GitWriteRefInput): Promise<void>;
  /** Delete a local ref; deleting a missing ref is a no-op. */
  deleteRef(ref: string): Promise<void>;
  /** Store bytes as a loose blob; resolves with its oid. */
  writeBlob(content: Uint8Array): Promise<string>;
  readBlob(oid: string): Promise<Uint8Array>;
  /** The best common ancestor of two commits (oids or refs), or null. */
  mergeBase(a: string, b: string): Promise<string | null>;
  /**
   * Replay the current branch's commits since the merge base onto `theirs`
   * and move the branch there, updating the index and every unmodified
   * worktree file. Files both sides changed go through the merge driver
   * (default: a line merge with conflict markers); a conflict moves nothing.
   */
  rebaseOnto(input: GitRebaseOntoInput): Promise<GitRebaseResult>;
}

/** The all-zero oid: "absent" in a ref update. */
export const ZERO_OID = "0000000000000000000000000000000000000000";

// ── Ports ────────────────────────────────────────────────────────────────
//
// Everything below crosses the worker boundary as plain data: no
// functions in method arguments. The ports themselves are injected once,
// at construction (`GitServiceDeps`).

/**
 * A remote, named by URL plus an opaque credential reference. The
 * reference is never a secret: the http/auth port resolves it (on desktop,
 * Rust looks the token up in the OS keychain and adds `Authorization`
 * itself, so no token ever reaches JS).
 */
export interface GitRemote {
  /** `https://host/owner/repo(.git)`. */
  url: string;
  /** Which stored credential to use, e.g. `"github.com/owner/repo"`. */
  credential?: string;
}

export interface GitHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Copied from `GitRemote.credential` for the port to resolve. */
  credential?: string;
}

export interface GitHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Makes one HTTP request. Resolves with any status (the package maps 401,
 * 403, 429 and 5xx itself); rejects only when no response arrived — a
 * network failure or the transport's own timeout. Timeouts are the port's
 * job: the package never sets a timer.
 */
export interface GitHttpClient {
  request(request: GitHttpRequest): Promise<GitHttpResponse>;
}

/**
 * Auth decorator, applied to every request before it reaches the http
 * client. It never hands a secret back to the package; it rewrites the
 * request for the credential the request names. Desktop injects none (its
 * http port authenticates in Rust); Node and tests use
 * `createBasicAuthProvider`.
 */
export interface GitAuthProvider {
  authorize(request: GitHttpRequest): GitHttpRequest | Promise<GitHttpRequest>;
}

/** Who wins overlapping edits in a merge: the local side or upstream. */
export type GitMergeHolder = "ours" | "theirs";

/**
 * One file both sides changed. `null` means absent on that side (added,
 * or deleted). In `rebaseOnto`, `ours` is the local commit being replayed
 * and `theirs` is upstream (the reverse of git's own rebase labels).
 */
export interface GitMergeInput {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  holder: GitMergeHolder;
}

export type GitMergeOutput =
  /** `content: null` deletes the file. `overwritten`: loser text the holder's edits replaced. */
  { content: string | null; overwritten: string[] } | { failed: string };

/** Replaces the default line merge (conflict markers) for files both sides changed. */
export interface GitMergeDriver {
  merge(input: GitMergeInput): GitMergeOutput | Promise<GitMergeOutput>;
}

/** Optional ports for `IsomorphicGitService`; omitted, behaviour is real git's. */
export interface GitServiceDeps {
  /** Default: global `fetch` when the environment has one. */
  http?: GitHttpClient;
  auth?: GitAuthProvider;
  /** Default: a line merge that leaves conflict markers (and reports a conflict). */
  mergeDriver?: GitMergeDriver;
}

// ── Remote operation inputs and results ─────────────────────────────────

export interface GitRemoteRef {
  ref: string;
  oid: string;
}

export interface GitFetchRef {
  /** Full remote ref name, e.g. `refs/heads/main`. */
  ref: string;
  /**
   * The tip a poll already saw: when it's already local, the ref costs no
   * request. Otherwise the ref's current tip is fetched (and reported),
   * which may be newer.
   */
  oid?: string;
  /** Local ref to point at the fetched tip, e.g. `refs/remotes/origin/main`. */
  localRef?: string;
}

export interface GitFetchRefsOptions {
  /**
   * A commit the remote can assume we have; only the first is sent.
   * Default: HEAD. An empty list sends none.
   */
  haves?: string[];
}

export interface GitFetchRefsResult {
  /** The refs found, with the oid fetched for each. */
  refs: Array<{ ref: string; oid: string; localRef?: string }>;
  /** Requested refs the remote doesn't have. Their `localRef`s are untouched. */
  missing: string[];
  /** Objects received (0 when everything was already local). */
  objectCount: number;
}

export interface GitRefUpdate {
  ref: string;
  /** Expected current value on the remote; `ZERO_OID` = must not exist. */
  old: string;
  /** New value; `ZERO_OID` deletes the ref. */
  new: string;
}

export interface GitPushRefsOptions {
  /** All updates land or none do. Requires the remote's `atomic` capability. */
  atomic?: boolean;
  /**
   * Objects the remote is known to have beyond the updates' `old` values,
   * so the pack leaves them out (e.g. the polled branch tip).
   */
  haves?: string[];
}

export type GitRefUpdateStatus =
  { ref: string; ok: true } | { ref: string; ok: false; reason: string };

export interface GitPushRefsResult {
  /** True when the pack unpacked and every ref update was accepted. */
  ok: boolean;
  /** `"ok"`, or the remote's unpack error. */
  unpack: string;
  refs: GitRefUpdateStatus[];
  /** Remote progress/hook messages (side band 2), if any. */
  messages: string[];
}

// ── Local plumbing inputs and results ───────────────────────────────────

export interface GitWriteRefInput {
  ref: string;
  oid: string;
  /** Overwrite an existing ref (default true). */
  force?: boolean;
}

export interface GitRebaseOntoInput {
  /** Upstream commit (oid or ref) to replay onto. */
  theirs: string;
  /** Passed to the merge driver for every file both sides changed. Default `"theirs"`. */
  holder?: GitMergeHolder;
}

export interface GitMergedFile {
  /** The local commit whose replay merged this file. */
  commit: string;
  path: string;
  overwritten: string[];
}

export type GitConflictReason =
  /** The default line merge left conflict markers (see `content`). */
  | "content"
  /** One side deleted, the other modified (default driver only). */
  | "modify-delete"
  /** Both sides changed a binary file. */
  | "binary"
  /** The injected driver returned `{ failed }` (see `message`). */
  | "driver";

export interface GitConflict {
  commit: string;
  path: string;
  reason: GitConflictReason;
  /** The merged text with conflict markers (`reason: "content"`). */
  content?: string;
  message?: string;
}

export type GitRebaseResult =
  /** `theirs` is already in the branch. Nothing moved. */
  | { status: "up-to-date"; oid: string }
  /** The branch had nothing of its own; it now points at `theirs`. */
  | { status: "fast-forward"; oid: string; skippedDirty: string[] }
  /** Local commits replayed onto `theirs`; the branch points at `oid`. */
  | {
      status: "rebased";
      oid: string;
      /** Commits created (empty replays are dropped, like git). */
      replayed: number;
      merged: GitMergedFile[];
      /** Worktree files left alone because they had uncommitted edits. */
      skippedDirty: string[];
    }
  /** A replay conflicted. Nothing moved: branch, index and worktree are as before. */
  | { status: "conflicted"; conflicts: GitConflict[] }
  /** No common history (rewritten upstream). Nothing moved. */
  | { status: "unrelated" };
