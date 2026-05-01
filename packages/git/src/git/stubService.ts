import { GitError } from "./types";
import type {
  GitAddInput,
  GitCheckoutPathsInput,
  GitCommitInput,
  GitCreateBranchInput,
  GitFetchInput,
  GitListBranchesInput,
  GitLogInput,
  GitPullInput,
  GitPushInput,
  GitService,
  RepoStatus,
  GitSwitchBranchInput,
  GitUnstageInput,
} from "./types";

function unsupported(operation: string): never {
  throw new GitError(
    "UnsupportedOperation",
    `Git operation '${operation}' is not implemented yet.`,
  );
}

export class StubGitService implements GitService {
  async status(input: { repoPath: string }): Promise<RepoStatus> {
    return {
      repoPath: input.repoPath,
      currentBranch: "main",
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      ahead: 0,
      behind: 0,
    };
  }

  async add(_input: GitAddInput): Promise<void> {
    unsupported("add");
  }

  async unstage(_input: GitUnstageInput): Promise<void> {
    unsupported("unstage");
  }

  async commit(_input: GitCommitInput): Promise<string> {
    unsupported("commit");
  }

  async listBranches(_input: GitListBranchesInput): Promise<string[]> {
    return ["main"];
  }

  async createBranch(_input: GitCreateBranchInput): Promise<void> {
    unsupported("createBranch");
  }

  async switchBranch(_input: GitSwitchBranchInput): Promise<void> {
    unsupported("switchBranch");
  }

  async checkoutPaths(_input: GitCheckoutPathsInput): Promise<void> {
    unsupported("checkoutPaths");
  }

  async log(
    _input: GitLogInput,
  ): Promise<import("isomorphic-git").ReadCommitResult[]> {
    return [];
  }

  async fetch(
    _input: GitFetchInput,
  ): Promise<import("isomorphic-git").FetchResult> {
    unsupported("fetch");
  }

  async pull(_input: GitPullInput): Promise<void> {
    unsupported("pull");
  }

  async push(
    _input: GitPushInput,
  ): Promise<import("isomorphic-git").PushResult> {
    unsupported("push");
  }
}
