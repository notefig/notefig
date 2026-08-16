import git from "isomorphic-git";

import { createIsomorphicGitFs } from "./isomorphicGitFs";
import {
  GitError,
  type GitAddInput,
  type GitCheckoutPathsInput,
  type GitCommitInput,
  type GitCreateBranchInput,
  type GitFetchInput,
  type GitFileChange,
  type GitInitInput,
  type GitListBranchesInput,
  type GitLogInput,
  type GitPullInput,
  type GitPushInput,
  type GitReadTextFileInput,
  type GitRemoveInput,
  type GitRestoreTreeInput,
  type GitRestoreTreeResult,
  type GitAddAllAndCommitInput,
  type GitAbortRevertInput,
  type GitRevertCommitInput,
  type GitService,
  type GitStatusInput,
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

/** Defaults to `<repoPath>/.git` — byte-identical to pre-gitDir behavior. */
function resolveGitDir(input: { repoPath: string; gitDir?: string }): string {
  return input.gitDir ?? joinGitPath(input.repoPath, ".git");
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

  switch (name) {
    case "NotFoundError":
      return new GitError("RepoNotFound", message, error);
    case "FastForwardError":
    case "PushRejectedError":
      return new GitError("NotFastForward", message, error);
    default:
      return new GitError("CorruptRepository", message, error);
  }
}

function validateMessage(message: string): void {
  if (!message.trim()) {
    throw new GitError("InvalidInput", "Commit message cannot be empty.");
  }
}

function isMissingHeadMessage(message: string): boolean {
  return /could not find head/i.test(message);
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

export class IsomorphicGitService implements GitService {
  private readonly fsClient;

  constructor(private readonly host: GitStorageHost) {
    this.fsClient = createIsomorphicGitFs(host);
  }

  private async ensureInitControlFiles(input: GitInitInput): Promise<void> {
    const defaultBranch = input.defaultBranch ?? "master";
    const gitDir = resolveGitDir(input);
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

  async init(input: GitInitInput): Promise<void> {
    await this.ensureInitControlFiles(input);
    const gitdir = resolveGitDir(input);

    try {
      await git.init({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir,
      });
    } catch (error) {
      const headPath = joinGitPath(gitdir, "HEAD");
      const configPath = joinGitPath(gitdir, "config");
      const [headStat, configStat] = await Promise.all([
        this.host.stat(headPath),
        this.host.stat(configPath),
      ]);

      if (headStat.exists && configStat.exists) {
        return;
      }

      throw toGitError(error);
    }
  }

  async status(input: GitStatusInput): Promise<RepoStatus> {
    const gitdir = resolveGitDir(input);
    try {
      let branch: string | null = null;

      try {
        const currentBranch = await git.currentBranch({
          fs: this.fsClient,
          dir: input.repoPath,
          gitdir,
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
          this.host.stat(joinGitPath(gitdir, "HEAD")),
          this.host.stat(joinGitPath(gitdir, "config")),
        ]);

        if (!headStat.exists || !configStat.exists) {
          throw gitError;
        }
      }

      const matrix = await git.statusMatrix({
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir,
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

      return {
        repoPath: input.repoPath,
        currentBranch: branch ?? "HEAD",
        staged,
        unstaged,
        untracked,
        conflicts,
      };
    } catch (error) {
      throw toGitError(error);
    }
  }

  async add(input: GitAddInput): Promise<void> {
    try {
      await git.add({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async remove(input: GitRemoveInput): Promise<void> {
    try {
      await git.remove({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async unstage(input: GitUnstageInput): Promise<void> {
    try {
      await git.resetIndex({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async commit(input: GitCommitInput): Promise<string> {
    validateMessage(input.message ?? "");

    try {
      return await git.commit({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async addAllAndCommit(
    input: GitAddAllAndCommitInput,
  ): Promise<string | null> {
    validateMessage(input.message ?? "Checkpoint");

    const status = await this.status({
      repoPath: input.repoPath,
      gitDir: input.gitDir,
    });

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
      await this.add({
        repoPath: input.repoPath,
        gitDir: input.gitDir,
        filepath,
      });
    }

    for (const filepath of pathsToRemove) {
      await this.remove({
        repoPath: input.repoPath,
        gitDir: input.gitDir,
        filepath,
      });
    }

    const afterStage = await this.status({
      repoPath: input.repoPath,
      gitDir: input.gitDir,
    });
    if (afterStage.staged.length === 0) {
      return null;
    }

    return this.commit({
      repoPath: input.repoPath,
      gitDir: input.gitDir,
      message: input.message ?? "Checkpoint",
      author: input.author,
      committer: input.committer,
    });
  }

  private async computeRevertChanges(
    repoPath: string,
    gitdir: string,
    commitOid: string,
  ): Promise<{ parentOid: string; changes: RevertChange[] }> {
    const { commit } = await git.readCommit({
      fs: this.fsClient,
      dir: repoPath,
      gitdir,
      oid: commitOid,
    });

    const parentOid = commit.parent?.[0];
    if (!parentOid) {
      throw new GitError("InvalidInput", "Cannot revert the initial commit.");
    }

    const [parentFiles, commitFiles, headOid] = await Promise.all([
      git.listFiles({
        fs: this.fsClient,
        dir: repoPath,
        gitdir,
        ref: parentOid,
      }),
      git.listFiles({
        fs: this.fsClient,
        dir: repoPath,
        gitdir,
        ref: commitOid,
      }),
      git.resolveRef({ fs: this.fsClient, dir: repoPath, gitdir, ref: "HEAD" }),
    ]);

    const headFiles = await git.listFiles({
      fs: this.fsClient,
      dir: repoPath,
      gitdir,
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
          dir: repoPath,
          gitdir,
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
    const gitdir = resolveGitDir(input);
    try {
      const { parentOid, changes } = await this.computeRevertChanges(
        input.repoPath,
        gitdir,
        input.oid,
      );

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
          await this.remove({
            repoPath: input.repoPath,
            gitDir: input.gitDir,
            filepath: change.path,
          });
          continue;
        }

        await git.checkout({
          fs: this.fsClient,
          dir: input.repoPath,
          gitdir,
          ref: parentOid,
          filepaths: [change.path],
          force: true,
          noUpdateHead: true,
        });
        await this.add({
          repoPath: input.repoPath,
          gitDir: input.gitDir,
          filepath: change.path,
        });
      }

      const status = await this.status({
        repoPath: input.repoPath,
        gitDir: input.gitDir,
      });
      if (status.staged.length === 0) {
        return null;
      }

      const message = input.message ?? `Revert ${input.oid.slice(0, 7)}`;

      return this.commit({
        repoPath: input.repoPath,
        gitDir: input.gitDir,
        message,
        author: input.author,
        committer: input.committer,
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async abortRevert(input: GitAbortRevertInput): Promise<void> {
    try {
      await git.checkout({
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
        ref: "HEAD",
        force: true,
        noUpdateHead: true,
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async listBranches(input: GitListBranchesInput): Promise<string[]> {
    try {
      return await git.listBranches({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  async createBranch(input: GitCreateBranchInput): Promise<void> {
    try {
      await git.branch({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
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
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      throw toGitError(error);
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
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
        ref: input.ref ?? "HEAD",
        force: input.force ?? true,
        noUpdateHead: input.noUpdateHead ?? true,
      });
    } catch (error) {
      throw toGitError(error);
    }
  }

  /**
   * Materialize `ref`'s tree into the worktree by diffing it against HEAD:
   * only files whose blob differs at the ref (or exist only there) are
   * checked out (index updated to match), and files tracked at HEAD but
   * absent at the ref are removed from worktree and index. Untracked/
   * ignored files are never touched, and HEAD does not move — history
   * stays append-only; the caller decides whether the resulting dirty
   * state becomes a new commit.
   *
   * The diff is against HEAD, not the worktree: callers must commit any
   * dirty state first (the jump flow's safety checkpoint), or dirty files
   * whose committed blob already matches the ref keep their dirty content.
   */
  async restoreTree(input: GitRestoreTreeInput): Promise<GitRestoreTreeResult> {
    if (!input.ref) {
      throw new GitError("InvalidInput", "restoreTree requires a ref.");
    }

    const gitdir = resolveGitDir(input);
    try {
      const changed: string[] = [];
      const toDelete: string[] = [];
      await git.walk({
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir,
        trees: [git.TREE({ ref: input.ref }), git.TREE({ ref: "HEAD" })],
        map: async (filepath, [target, head]) => {
          if (filepath === ".") return true;
          const [targetType, headType] = await Promise.all([
            target?.type(),
            head?.type(),
          ]);
          if (targetType === "tree" || headType === "tree") {
            // Prune identical subtrees — their contents can't differ.
            if (
              targetType === "tree" &&
              headType === "tree" &&
              (await target!.oid()) === (await head!.oid())
            ) {
              return null;
            }
            return true;
          }
          const [targetOid, headOid] = await Promise.all([
            target?.oid(),
            head?.oid(),
          ]);
          if (targetOid !== undefined && targetOid !== headOid) {
            changed.push(filepath);
          } else if (targetOid === undefined && headOid !== undefined) {
            toDelete.push(filepath);
          }
          return true;
        },
      });

      if (changed.length > 0) {
        await git.checkout({
          fs: this.fsClient,
          dir: input.repoPath,
          gitdir,
          ref: input.ref,
          filepaths: changed,
          force: true,
          noUpdateHead: true,
        });
      }

      for (const filepath of toDelete) {
        const absolute = joinGitPath(input.repoPath, filepath);
        // Delete first, verify on failure: host errors are untyped, and a
        // stat-first check would let a FAILING existence probe (adapters
        // map stat errors to exists:false) skip the delete yet still clear
        // the index. Attempting the delete unconditionally means the only
        // swallowed error is one where the file is verifiably absent —
        // anything else fails the restore rather than reporting a deletion
        // that left stale content on disk.
        try {
          await this.host.deleteFile(absolute);
        } catch (error) {
          const stat = await this.host.stat(absolute);
          if (stat.exists) throw error;
        }
        await git.remove({
          fs: this.fsClient,
          dir: input.repoPath,
          gitdir,
          filepath,
        });
      }

      return { restored: changed, deleted: toDelete };
    } catch (error) {
      throw toGitError(error);
    }
  }

  async log(input: GitLogInput) {
    try {
      return await git.log({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
      });
    } catch (error) {
      const gitError = toGitError(error);

      if (gitError.code === "RepoNotFound") {
        try {
          await this.status({ repoPath: input.repoPath, gitDir: input.gitDir });
          return [];
        } catch (statusError) {
          throw toGitError(statusError);
        }
      }

      throw gitError;
    }
  }

  async readTextFile(input: GitReadTextFileInput): Promise<string> {
    try {
      const { blob } = await git.readBlob({
        fs: this.fsClient,
        dir: input.repoPath,
        gitdir: resolveGitDir(input),
        oid: input.ref,
        filepath: input.filepath,
      });
      return new TextDecoder().decode(blob);
    } catch (error) {
      throw toGitError(error);
    }
  }

  async fetch(
    _input: GitFetchInput,
  ): Promise<import("isomorphic-git").FetchResult> {
    throw new GitError(
      "UnsupportedOperation",
      "Fetch is not implemented in v1.",
    );
  }

  async pull(_input: GitPullInput): Promise<void> {
    throw new GitError(
      "UnsupportedOperation",
      "Pull is not implemented in v1.",
    );
  }

  async push(
    _input: GitPushInput,
  ): Promise<import("isomorphic-git").PushResult> {
    throw new GitError(
      "UnsupportedOperation",
      "Push is not implemented in v1.",
    );
  }
}
