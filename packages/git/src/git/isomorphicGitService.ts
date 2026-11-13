import git from "isomorphic-git";
import type { FsClient, MergeResult } from "isomorphic-git";

import { sshBridgeUrl, toIsomorphicHttp } from "./httpClient";
import { isSshRemote } from "./remoteUrl";
import { createIsomorphicGitFs } from "./isomorphicGitFs";
import {
  GitError,
  type GitAddInput,
  type GitBranchTarget,
  type GitDirection,
  type GitStatusInput,
  type GitCheckoutPathsInput,
  type GitCommitInput,
  type GitCreateBranchInput,
  type GitErrorCode,
  type GitFileChange,
  type GitInitInput,
  type GitListBranchesInput,
  type GitLogInput,
  type GitMergeInput,
  type GitPushRefInput,
  type GitReadTextFileInput,
  type GitRemote,
  type GitRemoteRef,
  type GitRemoteRefResult,
  type GitRemoveInput,
  type GitAddAllAndCommitInput,
  type GitRepoRef,
  type GitRevertCommitInput,
  type GitService,
  type GitServiceDeps,
  type GitStorageHost,
  type RepoStatus,
  type GitSwitchBranchInput,
  type GitUnstageInput,
} from "./types";

const textEncoder = new TextEncoder();

const ZERO_OID = "0".repeat(40);

const DEFAULT_REMOTE = "origin";

function joinGitPath(repoPath: string, relativePath: string): string {
  const base = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  return `${base}/${relativePath}`;
}

function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function toGitError(error: unknown): GitError {
  if (error instanceof GitError) {
    return error;
  }

  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "Error";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "Unknown git error";

  if (name === "HttpError") {
    const status = (error as { data?: { statusCode?: number } }).data
      ?.statusCode;
    return new GitError(codeForStatus(status), message, error);
  }
  return new GitError(
    CODE_BY_NAME[name] ?? "CorruptRepository",
    message,
    error,
  );
}

const CODE_BY_NAME: Record<string, GitErrorCode> = {
  NotFoundError: "RepoNotFound",
  FastForwardError: "NotFastForward",
  PushRejectedError: "NotFastForward",
  GitPushError: "PushRejected",
  MergeConflictError: "MergeRequired",
  MergeNotSupportedError: "UnsupportedOperation",
  NoRefspecError: "InvalidInput",
  ObjectTypeError: "InvalidInput",
  // The remote answered, but not in the git protocol.
  SmartHttpError: "RemoteError",
  ParseError: "RemoteError",
  EmptyServerResponseError: "RemoteError",
  UnknownTransportError: "RemoteError",
};

function codeForStatus(status: number | undefined): GitErrorCode {
  switch (status) {
    case 401:
      return "AuthRequired";
    case 403:
      return "AuthFailed";
    case 404:
      return "RepoNotFound";
    case 429:
      return "Throttled";
    case 495:
      return "HostUnverified";
    case 501:
      return "UnsupportedOperation";
    default:
      return "RemoteError";
  }
}

function isMissingRemoteRef(error: unknown, ref: string): boolean {
  const { name, data } = error as { name?: string; data?: { what?: string } };
  return name === "NotFoundError" && data?.what === ref;
}

function validateMessage(message: string): void {
  if (!message.trim()) {
    throw new GitError("InvalidInput", "Commit message cannot be empty.");
  }
}

function isMissingHeadMessage(message: string): boolean {
  return /could not find head/i.test(message);
}

/**
 * A read-memoizing view of an fs client, for bursts of gitdir-invariant
 * lookups (the `isIgnored` re-filter in `status`): each `git.isIgnored`
 * call re-walks the same exclude/.gitignore chain through the storage host,
 * and every host op is an IPC round-trip. Caching read/stat results for the
 * duration of one burst turns O(paths × depth) host calls into
 * O(distinct files touched).
 */
function memoizeReads(fsClient: FsClient): FsClient {
  const base = (fsClient as { promises: Record<string, unknown> }).promises;
  const cache = new Map<string, Promise<unknown>>();
  const memo =
    (method: string) =>
    (...args: unknown[]) => {
      const key = `${method}\u0000${JSON.stringify(args)}`;
      let result = cache.get(key);
      if (!result) {
        result = (base[method] as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        cache.set(key, result);
      }
      return result;
    };
  return {
    promises: {
      ...base,
      readFile: memo("readFile"),
      readdir: memo("readdir"),
      stat: memo("stat"),
      lstat: memo("lstat"),
    },
  } as unknown as FsClient;
}

function deriveStagedChangeType(
  headStatus: number,
  stageStatus: number,
): GitFileChange["type"] {
  if (headStatus === 0 && stageStatus > 0) {
    return "added";
  }

  if (headStatus > 0 && stageStatus === 0) {
    return "deleted";
  }

  if (headStatus > 0 && stageStatus > 0 && stageStatus !== headStatus) {
    return "modified";
  }

  return "modified";
}

function deriveUnstagedChangeType(
  stageStatus: number,
  workdirStatus: number,
): GitFileChange["type"] {
  if (stageStatus === 0 && workdirStatus > 0) {
    return "added";
  }

  if (stageStatus > 0 && workdirStatus === 0) {
    return "deleted";
  }

  if (stageStatus > 0 && workdirStatus > 0 && workdirStatus !== stageStatus) {
    return "modified";
  }

  return "modified";
}

type RevertChange = {
  path: string;
  type: "added" | "deleted" | "modified";
  parentOid?: string;
  commitOid?: string;
  headOid?: string;
};

function hasRevertConflict(change: RevertChange): boolean {
  if (!change.headOid) return false;
  return (
    change.headOid !== change.commitOid && change.headOid !== change.parentOid
  );
}

/**
 * A `GitService` over one repository, whose worktree/gitdir pair is bound at
 * construction (`GitRepoRef`) — operations cannot be aimed at another repo's
 * gitdir by a call-site mistake.
 */
const PLAIN_FILE_MODE = 0o100644;

function listPaths(paths: string[]): string {
  return paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ");
}

function localChangesError(paths: string[]): GitError {
  return new GitError("PullRefused", `Local changes in ${listPaths(paths)} would be overwritten. Commit them first.`);
}

export class IsomorphicGitService implements GitService {
  private readonly fsClient;
  private readonly dir: string;
  private readonly gitdir: string;
  /**
   * isomorphic-git's shared object cache, held for the service's lifetime:
   * without it every top-level call re-parses packfile indexes from
   * scratch — the measured multi-second first-status stall, paid again on
   * every refetch. Entries are content-addressed (oid-keyed), so they
   * cannot go stale; the index is mtime-checked by isomorphic-git itself.
   * Dropped whole when an operation reports the repo missing or corrupt,
   * so a deleted/rebuilt gitdir never serves ghosts.
   */
  private cache: Record<string, unknown> = {};

  constructor(
    private readonly host: GitStorageHost,
    repo: GitRepoRef,
    private readonly deps: GitServiceDeps = {},
  ) {
    this.fsClient = createIsomorphicGitFs(host);
    this.dir = repo.repoPath;
    this.gitdir = repo.gitDir;
  }

  /** Wrap-and-throw seam: classify, and drop the cache on repo-level loss. */
  private fail(error: unknown): GitError {
    const gitError = toGitError(error);
    if (
      gitError.code === "RepoNotFound" ||
      gitError.code === "CorruptRepository"
    ) {
      this.cache = {};
    }
    return gitError;
  }

  private async ensureInitControlFiles(input?: GitInitInput): Promise<void> {
    const defaultBranch = input?.defaultBranch ?? "master";
    const gitDir = this.gitdir;
    const headPath = joinGitPath(gitDir, "HEAD");
    const configPath = joinGitPath(gitDir, "config");
    const infoDir = joinGitPath(gitDir, "info");
    const hooksDir = joinGitPath(gitDir, "hooks");
    const objectsDir = joinGitPath(gitDir, "objects");
    const objectsInfoDir = joinGitPath(objectsDir, "info");
    const objectsPackDir = joinGitPath(objectsDir, "pack");
    const refsDir = joinGitPath(gitDir, "refs");
    const refsHeadsDir = joinGitPath(refsDir, "heads");
    const refsTagsDir = joinGitPath(refsDir, "tags");
    const descriptionPath = joinGitPath(gitDir, "description");
    const excludePath = joinGitPath(infoDir, "exclude");

    await this.host.createDir(gitDir);
    await this.host.createDir(infoDir);
    await this.host.createDir(hooksDir);
    await this.host.createDir(objectsDir);
    await this.host.createDir(objectsInfoDir);
    await this.host.createDir(objectsPackDir);
    await this.host.createDir(refsDir);
    await this.host.createDir(refsHeadsDir);
    await this.host.createDir(refsTagsDir);

    const headStat = await this.host.stat(headPath);
    if (!headStat.exists) {
      await this.host.writeFileAtomic(
        headPath,
        encodeText(`ref: refs/heads/${defaultBranch}\n`),
      );
    }

    const configStat = await this.host.stat(configPath);
    if (!configStat.exists) {
      await this.host.writeFileAtomic(
        configPath,
        encodeText(
          "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\n",
        ),
      );
    }

    const descriptionStat = await this.host.stat(descriptionPath);
    if (!descriptionStat.exists) {
      await this.host.writeFileAtomic(
        descriptionPath,
        encodeText(
          "Unnamed repository; edit this file 'description' to name the repository.\n",
        ),
      );
    }

    const excludeStat = await this.host.stat(excludePath);
    if (!excludeStat.exists) {
      await this.host.writeFileAtomic(
        excludePath,
        encodeText(
          "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n",
        ),
      );
    }
  }

  async init(input?: GitInitInput): Promise<void> {
    await this.ensureInitControlFiles(input);

    try {
      await git.init({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
      });
    } catch (error) {
      const headPath = joinGitPath(this.gitdir, "HEAD");
      const configPath = joinGitPath(this.gitdir, "config");
      const [headStat, configStat] = await Promise.all([
        this.host.stat(headPath),
        this.host.stat(configPath),
      ]);

      if (headStat.exists && configStat.exists) {
        return;
      }

      throw this.fail(error);
    }
  }

  async status(input?: GitStatusInput): Promise<RepoStatus> {
    try {
      let branch: string | null = null;

      try {
        const currentBranch = await git.currentBranch({
          fs: this.fsClient,
          dir: this.dir,
          gitdir: this.gitdir,
          fullname: false,
        });
        branch = currentBranch ?? null;
      } catch (error) {
        const gitError = toGitError(error);

        if (
          gitError.code !== "RepoNotFound" ||
          !isMissingHeadMessage(gitError.message)
        ) {
          throw gitError;
        }

        const [headStat, configStat] = await Promise.all([
          this.host.stat(joinGitPath(this.gitdir, "HEAD")),
          this.host.stat(joinGitPath(this.gitdir, "config")),
        ]);

        if (!headStat.exists || !configStat.exists) {
          throw gitError;
        }
      }

      const matrix = await git.statusMatrix({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ...(input?.filepaths ? { filepaths: input.filepaths } : {}),
      });

      const staged: GitFileChange[] = [];
      const unstaged: GitFileChange[] = [];
      const untracked: string[] = [];
      const conflicts: string[] = [];

      for (const [path, headStatus, workdirStatus, stageStatus] of matrix) {
        if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
          untracked.push(path);
          continue;
        }

        if (stageStatus !== headStatus) {
          staged.push({
            path,
            type: deriveStagedChangeType(headStatus, stageStatus),
          });
        }

        if (workdirStatus !== stageStatus) {
          unstaged.push({
            path,
            type: deriveUnstagedChangeType(stageStatus, workdirStatus),
          });
        }

        if (stageStatus === 3) {
          conflicts.push(path);
        }
      }

      // statusMatrix's internal ignore check reads `<dir>/.git`'s excludes,
      // not this repo's gitdir (isomorphic-git doesn't forward gitdir there
      // — upstream gap in statusMatrix's GitIgnoreManager call; delete this
      // filter when fixed), so this repo's own `info/exclude` never applies
      // during the walk. Re-filter untracked paths through isIgnored with
      // the gitdir explicit; tracked paths are never subject to ignore
      // rules. Reads are memoized for the burst — the chain of exclude/
      // .gitignore files is shared across paths.
      const ignoreFs = memoizeReads(this.fsClient);
      const visibleUntracked = (
        await Promise.all(
          untracked.map(async (filepath) => {
            const ignored = await git.isIgnored({
              fs: ignoreFs,
              dir: this.dir,
              gitdir: this.gitdir,
              filepath,
            });
            return ignored ? null : filepath;
          }),
        )
      ).filter((filepath): filepath is string => filepath !== null);

      return {
        repoPath: this.dir,
        currentBranch: branch ?? "HEAD",
        staged,
        unstaged,
        untracked: visibleUntracked,
        conflicts,
      };
    } catch (error) {
      throw this.fail(error);
    }
  }

  async add(input: GitAddInput): Promise<void> {
    try {
      await git.add({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async remove(input: GitRemoveInput): Promise<void> {
    try {
      await git.remove({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async unstage(input: GitUnstageInput): Promise<void> {
    try {
      await git.resetIndex({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async commit(input: GitCommitInput): Promise<string> {
    validateMessage(input.message ?? "");

    try {
      return await git.commit({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async addAllAndCommit(
    input: GitAddAllAndCommitInput,
  ): Promise<string | null> {
    validateMessage(input.message ?? "Checkpoint");

    const status = await this.status();

    const stagedPaths = new Set(status.staged.map((item) => item.path));
    const pathsToAdd = [
      ...status.untracked,
      ...status.unstaged
        .filter((item) => item.type !== "deleted")
        .map((item) => item.path)
        .filter((path) => !stagedPaths.has(path)),
    ];
    const pathsToRemove = status.unstaged
      .filter((item) => item.type === "deleted")
      .map((item) => item.path)
      .filter((path) => !stagedPaths.has(path));

    if (
      pathsToAdd.length === 0 &&
      pathsToRemove.length === 0 &&
      status.staged.length === 0
    ) {
      return null;
    }

    for (const filepath of pathsToAdd) {
      await this.add({ filepath });
    }

    for (const filepath of pathsToRemove) {
      await this.remove({ filepath });
    }

    const afterStage = await this.status();
    if (afterStage.staged.length === 0) {
      return null;
    }

    return this.commit({
      message: input.message ?? "Checkpoint",
      author: input.author,
      committer: input.committer,
    });
  }

  private async computeRevertChanges(
    commitOid: string,
  ): Promise<{ parentOid: string; changes: RevertChange[] }> {
    const { commit } = await git.readCommit({
      fs: this.fsClient,
      dir: this.dir,
      gitdir: this.gitdir,
      cache: this.cache,
      oid: commitOid,
    });

    const parentOid = commit.parent?.[0];
    if (!parentOid) {
      throw new GitError("InvalidInput", "Cannot revert the initial commit.");
    }

    const [parentFiles, commitFiles, headOid] = await Promise.all([
      git.listFiles({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ref: parentOid,
      }),
      git.listFiles({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ref: commitOid,
      }),
      git.resolveRef({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        ref: "HEAD",
      }),
    ]);

    const headFiles = await git.listFiles({
      fs: this.fsClient,
      dir: this.dir,
      gitdir: this.gitdir,
      cache: this.cache,
      ref: headOid,
    });

    const fileSet = new Set<string>([
      ...parentFiles,
      ...commitFiles,
      ...headFiles,
    ]);

    const getBlobOid = async (
      ref: string | undefined,
      filepath: string,
    ): Promise<string | undefined> => {
      if (!ref) return undefined;
      try {
        const result = await git.readBlob({
          fs: this.fsClient,
          dir: this.dir,
          gitdir: this.gitdir,
          cache: this.cache,
          oid: ref,
          filepath,
        });
        return result.oid;
      } catch {
        return undefined;
      }
    };

    const changes: RevertChange[] = [];

    for (const path of fileSet) {
      const [parentBlob, commitBlob, headBlob] = await Promise.all([
        getBlobOid(parentOid, path),
        getBlobOid(commitOid, path),
        getBlobOid(headOid, path),
      ]);

      if (!parentBlob && !commitBlob) continue;
      if (parentBlob === commitBlob) continue;

      const type: RevertChange["type"] =
        !parentBlob && commitBlob
          ? "added"
          : parentBlob && !commitBlob
            ? "deleted"
            : "modified";

      changes.push({
        path,
        type,
        parentOid: parentBlob,
        commitOid: commitBlob,
        headOid: headBlob,
      });
    }

    return { parentOid, changes };
  }

  async revertCommit(input: GitRevertCommitInput): Promise<string | null> {
    try {
      const { parentOid, changes } = await this.computeRevertChanges(input.oid);

      if (changes.length === 0) {
        return null;
      }

      const conflicts = changes.filter(hasRevertConflict);
      if (conflicts.length > 0) {
        throw new GitError(
          "MergeRequired",
          "Revert would conflict with current changes.",
        );
      }

      for (const change of changes) {
        if (change.type === "added") {
          if (!change.headOid) continue;
          await this.remove({ filepath: change.path });
          continue;
        }

        await git.checkout({
          fs: this.fsClient,
          dir: this.dir,
          gitdir: this.gitdir,
          cache: this.cache,
          ref: parentOid,
          filepaths: [change.path],
          force: true,
          noUpdateHead: true,
        });
        await this.add({ filepath: change.path });
      }

      const status = await this.status();
      if (status.staged.length === 0) {
        return null;
      }

      const message = input.message ?? `Revert ${input.oid.slice(0, 7)}`;

      return this.commit({
        message,
        author: input.author,
        committer: input.committer,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async abortRevert(): Promise<void> {
    try {
      await git.checkout({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ref: "HEAD",
        force: true,
        noUpdateHead: true,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async listBranches(input?: GitListBranchesInput): Promise<string[]> {
    try {
      return await git.listBranches({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async createBranch(input: GitCreateBranchInput): Promise<void> {
    try {
      await git.branch({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async switchBranch(input: GitSwitchBranchInput): Promise<void> {
    if (!input.ref) {
      throw new GitError("InvalidInput", "switchBranch requires a branch ref.");
    }

    try {
      await git.checkout({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async checkoutPaths(input: GitCheckoutPathsInput): Promise<void> {
    if (!input.filepaths || input.filepaths.length === 0) {
      throw new GitError(
        "InvalidInput",
        "checkoutPaths requires at least one file path.",
      );
    }

    try {
      await git.checkout({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ref: input.ref ?? "HEAD",
        force: input.force ?? true,
        noUpdateHead: input.noUpdateHead ?? true,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async log(input?: GitLogInput) {
    try {
      return await git.log({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      });
    } catch (error) {
      const gitError = toGitError(error);

      if (gitError.code === "RepoNotFound") {
        try {
          await this.status();
          return [];
        } catch (statusError) {
          throw this.fail(statusError);
        }
      }

      throw gitError;
    }
  }

  async readTextFile(input: GitReadTextFileInput): Promise<string> {
    try {
      const { blob } = await git.readBlob({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        oid: input.ref,
        filepath: input.filepath,
      });
      return new TextDecoder().decode(blob);
    } catch (error) {
      throw this.fail(error);
    }
  }

  private remote(remote: GitRemote) {
    if (!this.deps.http) {
      throw new GitError(
        "UnsupportedOperation",
        "Remote operations need an http client.",
      );
    }
    return {
      http: toIsomorphicHttp(this.deps.http, remote.credential),
      url: isSshRemote(remote.url) ? sshBridgeUrl(remote.url) : remote.url,
    };
  }

  private async config(path: string): Promise<string | undefined> {
    const value: unknown = await git.getConfig({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, path });
    return value === undefined || value === null ? undefined : String(value);
  }

  /** The remote's name and URL for this direction, as git picks them. */
  private async pickRemote(branch: string, direction: GitDirection, tracking: string | undefined) {
    if (direction === "pull") {
      const name = tracking ?? "origin";
      return { name, url: await this.config(`remote.${name}.url`) };
    }
    const name =
      (await this.config(`branch.${branch}.pushRemote`)) ?? (await this.config("remote.pushDefault")) ?? tracking ?? "origin";
    return { name, url: (await this.config(`remote.${name}.pushurl`)) ?? (await this.config(`remote.${name}.url`)) };
  }

  async remoteTarget(direction: GitDirection): Promise<GitBranchTarget | { problem: string }> {
    try {
      const branch = await git.currentBranch({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir });
      if (!branch) return { problem: "Check out a branch first." };
      const tracking = await this.config(`branch.${branch}.remote`);
      const { name, url } = await this.pickRemote(branch, direction, tracking);
      if (!url) return { problem: `This repository has no remote for ${branch}.` };
      const own = `refs/heads/${branch}`;
      const upstream = (await this.config(`branch.${branch}.merge`)) ?? own;
      if (direction === "pull") return { remote: name, url, branch, remoteRef: upstream, upstreamRenamed: false };
      return { remote: name, url, branch, remoteRef: own, upstreamRenamed: name === tracking && upstream !== own };
    } catch {
      return { problem: "This folder isn't a git repository." };
    }
  }

  private async headOf(ref: string): Promise<string> {
    const oid = await git.resolveRef({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, ref }).catch(() => null);
    if (!oid) throw new GitError("PullRefused", "This branch has no commits yet.");
    return oid;
  }

  async pushBranch(remote: GitRemote, target: GitBranchTarget): Promise<boolean> {
    if (target.upstreamRenamed) {
      throw new GitError("PushRejected", `${target.branch} tracks a branch with another name. Push it from a terminal.`);
    }
    const ref = `refs/heads/${target.branch}`;
    const ours = await this.headOf(ref);
    const refs = await this.listRemoteRefs(remote, [ref]);
    const theirs = refs.find((entry) => entry.ref === ref)?.oid ?? null;
    if (theirs === ours) {
      // As git does: a push whose reply was lost left this behind.
      await git.writeRef({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        ref: `refs/remotes/${remote.name ?? DEFAULT_REMOTE}/${target.branch}`,
        value: ours,
        force: true,
      });
      return false;
    }
    await this.pushRef(remote, { ref, oid: ours, expect: theirs });
    return true;
  }

  /** How many files a pull changes. Refuses what a checkout wouldn't catch:
   *  an edit staged on one of them, a file swapped with a folder, and a
   *  file mode the storage host can't set. */
  private async inspectPull(ours: string, theirs: string): Promise<number> {
    const swapped: string[] = [];
    const staged: string[] = [];
    const modes: string[] = [];
    let changed = 0;
    await git.walk({
      fs: this.fsClient,
      dir: this.dir,
      gitdir: this.gitdir,
      cache: this.cache,
      trees: [git.TREE({ ref: ours }), git.TREE({ ref: theirs }), git.STAGE()],
      map: async (filepath, [a, b, index]) => {
        if (filepath === ".") return undefined;
        const [typeA, typeB] = await Promise.all([a?.type(), b?.type()]);
        if (typeA === "tree" || typeB === "tree") {
          if (typeA === "blob" || typeB === "blob") swapped.push(filepath);
          return undefined;
        }
        const [oidA, oidB, oidIndex, modeA, modeB] = await Promise.all([a?.oid(), b?.oid(), index?.oid(), a?.mode(), b?.mode()]);
        if (oidA === oidB && modeA === modeB) return undefined;
        changed += 1;
        if (oidIndex !== oidA) staged.push(filepath);
        if (b && modeA !== modeB && (a || modeB !== PLAIN_FILE_MODE)) modes.push(filepath);
        return undefined;
      },
    });
    if (swapped.length > 0) {
      throw new GitError("PullRefused", `${listPaths(swapped)} changed between a file and a folder. Pull it in a terminal.`);
    }
    if (staged.length > 0) throw localChangesError(staged);
    if (modes.length > 0) throw new GitError("PullRefused", `File permissions changed for ${listPaths(modes)}. Pull it in a terminal.`);
    return changed;
  }

  private async checkoutTree(oid: string, dryRun: boolean): Promise<void> {
    try {
      await git.checkout({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, cache: this.cache, ref: oid, noUpdateHead: true, dryRun });
    } catch (error) {
      const conflicts = (error as { code?: string; data?: { filepaths?: string[] } });
      if (conflicts.code === "CheckoutConflictError") throw localChangesError(conflicts.data?.filepaths ?? []);
      throw error;
    }
  }

  async pullBranch(remote: GitRemote, target: GitBranchTarget): Promise<number> {
    const ref = `refs/heads/${target.branch}`;
    const [fetched] = await this.fetchRefs(remote, [target.remoteRef]);
    const theirs = fetched?.oid;
    if (!theirs) throw new GitError("PullRefused", `The remote has no ${target.remoteRef.replace("refs/heads/", "")} branch.`);
    const ours = await this.headOf(ref);
    if (ours === theirs) return 0;
    try {
      const [base] = await git.findMergeBase({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, cache: this.cache, oids: [ours, theirs] });
      if (base === theirs) return 0;
      if (base !== ours) throw new GitError("PullRefused", "This branch and the remote have both moved. Merge them in a terminal.");
      const changed = await this.inspectPull(ours, theirs);
      await this.checkoutTree(theirs, true);
      await this.checkoutTree(theirs, false);
      // Checkout takes a while, and a terminal can commit during it.
      if ((await this.headOf(ref)) !== ours) {
        throw new GitError("PullRefused", `${target.branch} got a new commit during the pull. Check it with git status in a terminal.`);
      }
      await git.writeRef({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, ref, value: theirs, force: true });
      return changed;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async listFiles(input?: { ref?: string }): Promise<string[]> {
    try {
      return await git.listFiles({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ref: input?.ref ?? "HEAD",
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async readFile(input: GitReadTextFileInput): Promise<Uint8Array | null> {
    try {
      const { blob } = await git.readBlob({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        oid: input.ref,
        filepath: input.filepath,
      });
      return blob;
    } catch (error) {
      if ((error as { name?: string }).name === "NotFoundError") return null;
      throw this.fail(error);
    }
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      const resolve = (ref: string) =>
        /^[0-9a-f]{40}$/.test(ref)
          ? ref
          : git.resolveRef({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, ref });
      const oids = await Promise.all([resolve(a), resolve(b)]);
      const [base] = await git.findMergeBase({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        oids,
      });
      return base ?? null;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async changedFiles(from: string, to: string, options?: { toApply?: boolean }): Promise<string[]> {
    const swapped: string[] = [];
    const modes: string[] = [];
    try {
      const changed = await git.walk({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
        map: async (filepath, [a, b]) => {
          if (filepath === ".") return undefined;
          const [oidA, oidB, typeA, typeB, modeA, modeB] = await Promise.all([a?.oid(), b?.oid(), a?.type(), b?.type(), a?.mode(), b?.mode()]);
          // Equal subtrees are skipped whole (null stops the descent).
          if (oidA === oidB && modeA === modeB) return null;
          if (typeA === "tree" || typeB === "tree") {
            // A file replaced by a folder (or back) is a change too.
            if (typeA !== "blob" && typeB !== "blob") return undefined;
            swapped.push(filepath);
            return filepath;
          }
          if (b && modeA !== modeB && (a || modeB !== PLAIN_FILE_MODE)) modes.push(filepath);
          return filepath;
        },
      });
      if (options?.toApply && swapped.length > 0) {
        throw new GitError("PullRefused", `${listPaths(swapped)} changed between a file and a folder. Pull it in a terminal.`);
      }
      if (options?.toApply && modes.length > 0) {
        throw new GitError("PullRefused", `File permissions changed for ${listPaths(modes)}. Pull it in a terminal.`);
      }
      return (changed as string[]).sort();
    } catch (error) {
      throw this.fail(error);
    }
  }

  async getConfig(path: string): Promise<string | undefined> {
    try {
      return await this.config(path);
    } catch (error) {
      throw this.fail(error);
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      const branch = await git.currentBranch({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
      });
      return branch ?? null;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async isIgnored(filepath: string): Promise<boolean> {
    try {
      return await git.isIgnored({ fs: this.fsClient, dir: this.dir, gitdir: this.gitdir, filepath });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async listRemoteRefs(
    remote: GitRemote,
    prefixes: string[] = [],
    options: { forPush?: boolean } = {},
  ): Promise<GitRemoteRef[]> {
    try {
      // Protocol v1 lists every ref in one GET, filtered here; v2 filters
      // on the server but costs a capability round trip and one prefix per call.
      const refs = await git.listServerRefs({
        ...this.remote(remote),
        protocolVersion: 1,
        forPush: options.forPush === true,
      });
      return refs
        .filter(
          ({ ref }) =>
            prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p)),
        )
        .map(({ ref, oid }) => ({ ref, oid }));
    } catch (error) {
      throw this.fail(error);
    }
  }

  async fetchRefs(
    remote: GitRemote,
    refs: string[],
  ): Promise<GitRemoteRefResult[]> {
    const results: GitRemoteRefResult[] = [];
    try {
      // isomorphic-git fetches one remote ref per call (an advertisement
      // GET, then an upload-pack POST).
      for (const ref of refs) {
        try {
          const { fetchHead } = await git.fetch({
            fs: this.fsClient,
            dir: this.dir,
            gitdir: this.gitdir,
            cache: this.cache,
            ...this.remote(remote),
            remote: remote.name ?? DEFAULT_REMOTE,
            remoteRef: ref,
            singleBranch: true,
            tags: false,
          });
          results.push({ ref, oid: fetchHead });
        } catch (error) {
          if (!isMissingRemoteRef(error, ref)) throw error;
          results.push({ ref, oid: null });
        }
      }
      return results;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /**
   * isomorphic-git's `push` sends a local ref; an oid stands in for one
   * (it passes 40 hex digits through), so no temporary local ref is
   * written. It writes a tracking ref under the named remote (`origin`
   * when unnamed), at `<remote ref
   * minus refs/heads>` after each push, even for non-branch refs. It walks
   * `oid` as a commit, so a blob can't be pushed (`InvalidInput`).
   */
  async pushRef(remote: GitRemote, input: GitPushRefInput): Promise<void> {
    try {
      await git.push({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        ...this.remote(remote),
        remote: remote.name ?? DEFAULT_REMOTE,
        ref: input.delete ? ZERO_OID : input.oid,
        remoteRef: input.ref,
        delete: input.delete,
        force: input.force,
        // The only hook isomorphic-git runs with the remote ref's oid as
        // it found it, before sending anything.
        onPrePush: ({ remoteRef }) => {
          if (
            input.expect !== undefined &&
            remoteRef.oid !== (input.expect ?? ZERO_OID)
          ) {
            throw new GitError(
              "RefConflict",
              `${input.ref} is at ${remoteRef.oid}, not ${input.expect ?? "absent"}.`,
            );
          }
          return true;
        },
      });
    } catch (error) {
      throw this.fail(error);
    }
  }

  async merge(input: GitMergeInput): Promise<MergeResult> {
    try {
      return await git.merge({
        ...input,
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
        mergeDriver: this.deps.mergeDriver,
      });
    } catch (error) {
      throw this.fail(error);
    }
  }
}
