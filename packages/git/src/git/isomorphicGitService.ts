import git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";

import { toGitError } from "./errors";
import { createIsomorphicGitFs } from "./isomorphicGitFs";
import { fetchRefs, pushRefs, type CapabilityCache } from "./remoteOps";
import { rebaseOnto, resolveCommitish } from "./repo/rebase";
import type { RepoContext } from "./repo/repoContext";
import { defaultHttpClient } from "./smartHttp/httpPorts";
import { lsRefs } from "./smartHttp/lsRefs";
import { createHttpTransport, type GitTransport } from "./smartHttp/transport";
import {
  GitError,
  type GitFetchRef,
  type GitFetchRefsOptions,
  type GitFetchRefsResult,
  type GitPushRefsOptions,
  type GitPushRefsResult,
  type GitRebaseOntoInput,
  type GitRebaseResult,
  type GitRefUpdate,
  type GitRemote,
  type GitRemoteRef,
  type GitServiceDeps,
  type GitWriteRefInput,
  type GitAddInput,
  type GitCheckoutPathsInput,
  type GitCommitInput,
  type GitCreateBranchInput,
  type GitFileChange,
  type GitInitInput,
  type GitListBranchesInput,
  type GitLogInput,
  type GitReadTextFileInput,
  type GitRemoveInput,
  type GitAddAllAndCommitInput,
  type GitRepoRef,
  type GitRevertCommitInput,
  type GitService,
  type GitStorageHost,
  type RepoStatus,
  type GitSwitchBranchInput,
  type GitUnstageInput,
} from "./types";

const textEncoder = new TextEncoder();

function joinGitPath(repoPath: string, relativePath: string): string {
  const base = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  return `${base}/${relativePath}`;
}

function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
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

  /** receive-pack capabilities per remote URL, looked up on first push. */
  private readonly pushCapabilities: CapabilityCache = new Map();

  constructor(
    private readonly host: GitStorageHost,
    repo: GitRepoRef,
    private readonly deps: GitServiceDeps = {},
  ) {
    this.fsClient = createIsomorphicGitFs(host);
    this.dir = repo.repoPath;
    this.gitdir = repo.gitDir;
  }

  private get ctx(): RepoContext {
    return {
      git: {
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        cache: this.cache,
      },
      host: this.host,
    };
  }

  private transport(remote: GitRemote): GitTransport {
    const http = this.deps.http ?? defaultHttpClient();
    if (!http) {
      throw new GitError(
        "UnsupportedOperation",
        "No http client to reach remotes with.",
      );
    }
    if (!/^https?:\/\//.test(remote.url)) {
      throw new GitError(
        "UnsupportedOperation",
        `Only HTTP(S) remotes are supported: ${remote.url}`,
      );
    }
    return createHttpTransport(remote, http, this.deps.auth);
  }

  /** Run `op`, classifying anything it throws. */
  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      throw this.fail(error);
    }
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

  async status(): Promise<RepoStatus> {
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

  async listRemoteRefs(
    remote: GitRemote,
    prefixes: string[],
  ): Promise<GitRemoteRef[]> {
    return this.run(() => lsRefs(this.transport(remote), prefixes));
  }

  async fetchRefs(
    remote: GitRemote,
    refs: GitFetchRef[],
    options?: GitFetchRefsOptions,
  ): Promise<GitFetchRefsResult> {
    return this.run(() =>
      fetchRefs(this.ctx, this.transport(remote), refs, options),
    );
  }

  async pushRefs(
    remote: GitRemote,
    updates: GitRefUpdate[],
    options?: GitPushRefsOptions,
  ): Promise<GitPushRefsResult> {
    const caps = { cache: this.pushCapabilities, key: remote.url };
    return this.run(() =>
      pushRefs(this.ctx, this.transport(remote), caps, updates, options),
    );
  }

  async readRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        ref,
      });
    } catch (error) {
      const gitError = toGitError(error);
      if (gitError.code === "RepoNotFound") return null;
      throw this.fail(error);
    }
  }

  async writeRef(input: GitWriteRefInput): Promise<void> {
    await this.run(() =>
      git.writeRef({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        ref: input.ref,
        value: input.oid,
        force: input.force ?? true,
      }),
    );
  }

  async deleteRef(ref: string): Promise<void> {
    if ((await this.readRef(ref)) === null) return;
    await this.run(() =>
      git.deleteRef({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        ref,
      }),
    );
  }

  async writeBlob(content: Uint8Array): Promise<string> {
    return this.run(() =>
      git.writeBlob({
        fs: this.fsClient,
        dir: this.dir,
        gitdir: this.gitdir,
        blob: content,
      }),
    );
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    return this.run(async () => {
      const { blob } = await git.readBlob({ ...this.ctx.git, oid });
      return blob;
    });
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    return this.run(async () => {
      const [oidA, oidB] = await Promise.all(
        [a, b].map((ref) => resolveCommitish(this.ctx, ref)),
      );
      const [base] = await git.findMergeBase({
        ...this.ctx.git,
        oids: [oidA, oidB],
      });
      return base ?? null;
    });
  }

  async rebaseOnto(input: GitRebaseOntoInput): Promise<GitRebaseResult> {
    return this.run(() => rebaseOnto(this.ctx, this.deps.mergeDriver, input));
  }
}
