/**
 * `core.workspace(ws).gitRemote`: a workspace's git remote, and pushing its
 * checked-out branch to it. Acts only when asked: opening a workspace costs
 * one `exists` call, and the git worker boots on the first `read` or `push`.
 */
import { defineModule } from "@notefig/core";
import { GitError, type GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import { gitWorkerModule, type GitWorker } from "@/modules/git-worker";
import { path as pathutil } from "@/utils/path";

declare module "@notefig/core" {
  interface WorkspaceModules {
    gitRemote: WorkspaceGitRemote;
  }
}

/** The checked-out branch and its remote. */
export interface GitRemoteTarget {
  url: string;
  branch: string;
}

export interface WorkspaceGitRemote {
  /** The folder is a git repo and the platform can reach remotes. */
  available(): Promise<boolean>;
  /** The branch and remote a push would use, or why there are none. */
  target(): Promise<GitRemoteTarget | { problem: string }>;
  /** Push the checked-out branch, only ever forward. Rejects with what
   *  to fix. */
  push(): Promise<"pushed" | "up-to-date">;
  dispose(): void;
}

export interface GitRemoteDeps {
  workspacePath: string;
  fs: Pick<FileSystemSurface, "exists">;
  gitWorker: GitWorker;
  supported: boolean;
}

function pushProblem(error: unknown, url: string): string {
  const where = url.replace(/^https:\/\//, "").replace(/\.git$/, "");
  const code = error instanceof GitError ? error.code : null;
  switch (code) {
    case "AuthRequired":
      return `No credentials can push to ${where}. Paste a token with write access.`;
    case "AuthFailed":
      return `These credentials can't push to ${where}. Use a token with write access to its contents.`;
    case "RepoNotFound":
      return `${where} wasn't found, or these credentials can't see it.`;
    case "Network":
      return `Couldn't reach ${new URL(url).host}. Check the connection and try again.`;
    case "Throttled":
      return "The host is rate limiting requests. Try again in a minute.";
    case "NotFastForward":
    case "RefConflict":
    case "PushRejected":
      return "The remote has commits this branch doesn't. Pull them first, then push.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export function createWorkspaceGitRemote(deps: GitRemoteDeps): WorkspaceGitRemote {
  const root = pathutil.normalize(deps.workspacePath);
  const gitDir = pathutil.join(root, ".git");
  let git: GitService | null = null;
  const service = () => (git ??= deps.gitWorker.create({ repoPath: root, gitDir }));

  const target = async (): Promise<GitRemoteTarget | { problem: string }> => {
    try {
      const branch = await service().currentBranch();
      if (!branch) return { problem: "Check out a branch to push it." };
      const name = (await service().getConfig(`branch.${branch}.remote`)) ?? "origin";
      const url = await service().getConfig(`remote.${name}.url`);
      if (!url) return { problem: `This repository has no remote to push ${branch} to.` };
      if (!/^https:\/\/[^/@\s]+\/\S+/.test(url)) return { problem: "Only HTTPS remotes are supported for now." };
      return { url, branch };
    } catch {
      return { problem: "Couldn't read this repository." };
    }
  };

  return {
    async available() {
      if (!deps.supported) return false;
      const [repo] = await deps.fs.exists([gitDir]);
      return repo?.exists === true;
    },
    target,
    async push() {
      const found = await target();
      if ("problem" in found) throw new Error(found.problem);
      const ref = `refs/heads/${found.branch}`;
      const remote = { url: found.url };
      try {
        const [head] = await service().log({ ref, depth: 1 });
        if (!head) throw new Error("This branch has no commits yet.");
        const refs = await service().listRemoteRefs(remote, [ref]);
        const theirs = refs.find((entry) => entry.ref === ref)?.oid ?? null;
        if (theirs === head.oid) return "up-to-date";
        await service().pushRef(remote, { ref, oid: head.oid, expect: theirs });
        return "pushed";
      } catch (error) {
        throw new Error(pushProblem(error, found.url));
      }
    },
    dispose() {
      if (git) deps.gitWorker.dispose(gitDir);
    },
  };
}

export const gitRemoteModule = defineModule({
  name: "gitRemote",
  needs: [platformModule, gitWorkerModule],
  workspace: {
    create: (ctx) =>
      createWorkspaceGitRemote({
        workspacePath: ctx.workspace.path,
        fs: ctx.use("platform").fs,
        gitWorker: ctx.use("gitWorker"),
        supported: ctx.use("platform").gitHttp.supported,
      }),
    dispose: (remote) => remote.dispose(),
  },
});
