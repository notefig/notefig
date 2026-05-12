import type {
  add as igAdd,
  branch as igBranch,
  checkout as igCheckout,
  commit as igCommit,
  fetch as igFetch,
  init as igInit,
  listBranches as igListBranches,
  log as igLog,
  pull as igPull,
  push as igPush,
  remove as igRemove,
  resetIndex as igResetIndex,
} from "isomorphic-git";

type WithRepoPath<T> = Omit<T, "fs" | "dir" | "gitdir"> & { repoPath: string };

type AddParams = Parameters<typeof igAdd>[0];
type BranchParams = Parameters<typeof igBranch>[0];
type CheckoutParams = Parameters<typeof igCheckout>[0];
type CommitParams = Parameters<typeof igCommit>[0];
type FetchParams = Parameters<typeof igFetch>[0];
type InitParams = Parameters<typeof igInit>[0];
type ListBranchesParams = Parameters<typeof igListBranches>[0];
type LogParams = Parameters<typeof igLog>[0];
type PullParams = Parameters<typeof igPull>[0];
type PushParams = Parameters<typeof igPush>[0];
type RemoveParams = Parameters<typeof igRemove>[0];
type ResetIndexParams = Parameters<typeof igResetIndex>[0];

export type GitChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechange";

export type GitErrorCode =
  | "AuthRequired"
  | "AuthFailed"
  | "NotFastForward"
  | "MergeRequired"
  | "LockUnavailable"
  | "RepoNotFound"
  | "UnsupportedOperation"
  | "CorruptRepository"
  | "InvalidInput";

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

export type GitAddInput = WithRepoPath<AddParams>;
export type GitInitInput = WithRepoPath<InitParams>;
export type GitUnstageInput = WithRepoPath<ResetIndexParams>;
export type GitRemoveInput = WithRepoPath<RemoveParams>;
export type GitCommitInput = WithRepoPath<CommitParams>;
export type GitAddAllAndCommitInput = {
  repoPath: string;
  message?: string;
  author: NonNullable<CommitParams["author"]>;
  committer?: CommitParams["committer"];
};
export type GitRevertCommitInput = {
  repoPath: string;
  oid: string;
  author: NonNullable<CommitParams["author"]>;
  committer?: CommitParams["committer"];
  message?: string;
};
export type GitAbortRevertInput = {
  repoPath: string;
};
export type GitListBranchesInput = WithRepoPath<ListBranchesParams>;
export type GitCreateBranchInput = WithRepoPath<BranchParams>;
export type GitSwitchBranchInput = WithRepoPath<
  Pick<CheckoutParams, "ref" | "force" | "track" | "remote">
>;
export type GitCheckoutPathsInput = WithRepoPath<
  Pick<
    CheckoutParams,
    "ref" | "filepaths" | "force" | "noCheckout" | "noUpdateHead"
  >
>;
export type GitLogInput = WithRepoPath<LogParams>;
export type GitFetchInput = WithRepoPath<FetchParams>;
export type GitPullInput = WithRepoPath<PullParams>;
export type GitPushInput = WithRepoPath<PushParams>;

export interface GitService {
  init(input: GitInitInput): ReturnType<typeof igInit>;
  status(input: { repoPath: string }): Promise<RepoStatus>;
  add(input: GitAddInput): ReturnType<typeof igAdd>;
  remove(input: GitRemoveInput): ReturnType<typeof igRemove>;
  unstage(input: GitUnstageInput): ReturnType<typeof igResetIndex>;
  commit(input: GitCommitInput): ReturnType<typeof igCommit>;
  addAllAndCommit(input: GitAddAllAndCommitInput): Promise<string | null>;
  revertCommit(input: GitRevertCommitInput): Promise<string | null>;
  abortRevert(input: GitAbortRevertInput): Promise<void>;
  listBranches(input: GitListBranchesInput): ReturnType<typeof igListBranches>;
  createBranch(input: GitCreateBranchInput): ReturnType<typeof igBranch>;
  switchBranch(input: GitSwitchBranchInput): ReturnType<typeof igCheckout>;
  checkoutPaths(input: GitCheckoutPathsInput): ReturnType<typeof igCheckout>;
  log(input: GitLogInput): ReturnType<typeof igLog>;
  fetch(input: GitFetchInput): ReturnType<typeof igFetch>;
  pull(input: GitPullInput): ReturnType<typeof igPull>;
  push(input: GitPushInput): ReturnType<typeof igPush>;
}
