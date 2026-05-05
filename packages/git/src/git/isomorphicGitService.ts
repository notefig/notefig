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

function deriveChangeType(
  headStatus: number,
  workdirStatus: number,
  stageStatus: number,
): GitFileChange["type"] {
  if (headStatus === 0 && (workdirStatus > 0 || stageStatus > 0)) {
    return "added";
  }

  if (headStatus > 0 && workdirStatus === 0 && stageStatus === 0) {
    return "deleted";
  }

  return "modified";
}

export class IsomorphicGitService implements GitService {
  private readonly fsClient;

  constructor(private readonly host: GitStorageHost) {
    this.fsClient = createIsomorphicGitFs(host);
  }

  private async ensureInitControlFiles(input: GitInitInput): Promise<void> {
    const defaultBranch = input.defaultBranch ?? "master";
    const gitDir = joinGitPath(input.repoPath, ".git");
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

    try {
      await git.init({
        ...input,
        fs: this.fsClient,
        dir: input.repoPath,
      });
    } catch (error) {
      const headPath = joinGitPath(input.repoPath, ".git/HEAD");
      const configPath = joinGitPath(input.repoPath, ".git/config");
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

  async status(input: { repoPath: string }): Promise<RepoStatus> {
    try {
      let branch: string | null = null;

      try {
        const currentBranch = await git.currentBranch({
          fs: this.fsClient,
          dir: input.repoPath,
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
      }

      const matrix = await git.statusMatrix({
        fs: this.fsClient,
        dir: input.repoPath,
      });

      const staged: GitFileChange[] = [];
      const unstaged: GitFileChange[] = [];
      const untracked: string[] = [];
      const conflicts: string[] = [];

      for (const [path, headStatus, workdirStatus, stageStatus] of matrix) {
        const changeType = deriveChangeType(
          headStatus,
          workdirStatus,
          stageStatus,
        );

        if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
          untracked.push(path);
          continue;
        }

        if (stageStatus !== headStatus) {
          staged.push({ path, type: changeType });
        }

        if (workdirStatus !== stageStatus) {
          unstaged.push({ path, type: changeType });
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
        ref: input.ref ?? "HEAD",
        force: input.force ?? true,
        noUpdateHead: input.noUpdateHead ?? true,
      });
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
      });
    } catch (error) {
      const gitError = toGitError(error);

      if (gitError.code === "RepoNotFound") {
        try {
          await this.status({ repoPath: input.repoPath });
          return [];
        } catch (statusError) {
          throw toGitError(statusError);
        }
      }

      throw gitError;
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
