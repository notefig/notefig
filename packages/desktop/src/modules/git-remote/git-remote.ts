/**
 * `core.workspace(ws).gitRemote`: push and pull the checked-out branch when
 * asked (the command palette), in the git worker. Nothing runs otherwise.
 *
 * What a pull changes reaches open editors the way a terminal `git pull`
 * does: through the file watcher.
 */
import { defineModule } from "@notefig/core";
import { GitError, type GitBranchTarget, type GitDirection, type GitRemote, type GitService } from "@notefig/git";
import { platformModule } from "@/core/services";
import { gitWorkerModule, type GitWorker } from "@/modules/git-worker";
import { path as pathutil } from "@/utils/path";

declare module "@notefig/core" {
  interface WorkspaceModules {
    gitRemote: WorkspaceGitRemote;
  }
}

export interface WorkspaceGitRemote {
  /** Where a push (the default) or pull goes, or why it can't. */
  target(direction?: GitDirection): Promise<GitBranchTarget | { problem: string }>;
  /** Rejects with what to fix. `pushed` is false if the remote has it. */
  push(): Promise<{ branch: string; pushed: boolean }>;
  /** Fast-forward; how many files changed. Rejects with what to fix. */
  pull(): Promise<number>;
  dispose(): void;
}

function problemOf(error: unknown, url: string): string {
  const where = url.replace(/^https:\/\//, "").replace(/\.git$/, "");
  const code = error instanceof GitError ? error.code : "";
  if (code === "AuthRequired") return `No credentials work for ${where}. Run "Git: Use a Token for This Remote".`;
  if (code === "AuthFailed") return `These credentials can't access ${where}. It needs write access to its contents.`;
  if (code === "RepoNotFound") return `${where} wasn't found, or these credentials can't see it.`;
  if (code === "Network") return `Couldn't reach ${new URL(url).host}. Check the connection and try again.`;
  if (code === "Throttled") return "The host is rate limiting requests. Try again in a minute.";
  if (code === "NotFastForward" || code === "RefConflict") return "The remote has commits this branch doesn't. Pull them first, then push.";
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspaceGitRemote(deps: { workspacePath: string; gitWorker: GitWorker }): WorkspaceGitRemote {
  const root = pathutil.normalize(deps.workspacePath);
  const gitDir = pathutil.join(root, ".git");
  let git: GitService | null = null;
  const service = () => (git ??= deps.gitWorker.create({ repoPath: root, gitDir }));

  const target: WorkspaceGitRemote["target"] = async (direction = "push") => {
    const found = await service().remoteTarget(direction);
    if ("url" in found && !/^https:\/\/[^/@\s]+\/\S+/.test(found.url)) {
      return { problem: "Only HTTPS remotes are supported for now." };
    }
    return found;
  };

  /** Run `work` on the target, its failures said in the user's terms. */
  const onTarget = async <T>(
    direction: GitDirection,
    work: (remote: GitRemote, found: GitBranchTarget) => Promise<T>,
  ): Promise<T> => {
    const found = await target(direction);
    if ("problem" in found) throw new Error(found.problem);
    try {
      // The repository whose git config applies when finding the credential.
      return await work({ url: found.url, credential: root }, found);
    } catch (error) {
      throw new Error(problemOf(error, found.url));
    }
  };

  return {
    target,
    push: () =>
      onTarget("push", async (remote, found) => ({
        branch: found.branch,
        pushed: await service().pushBranch(remote, found),
      })),
    pull: () => onTarget("pull", (remote, found) => service().pullBranch(remote, found)),
    dispose() {
      if (git) deps.gitWorker.dispose(gitDir);
    },
  };
}

export const gitRemoteModule = defineModule({
  name: "gitRemote",
  needs: [platformModule, gitWorkerModule],
  workspace: {
    create: (ctx) => createWorkspaceGitRemote({ workspacePath: ctx.workspace.path, gitWorker: ctx.use("gitWorker") }),
    dispose: (remote) => remote.dispose(),
  },
});
