/**
 * `core.workspace(ws).gitRemote`: push and pull the checked-out branch when
 * asked (the command palette), in the git worker. Nothing runs otherwise.
 *
 * What a pull changes reaches open editors the way a terminal `git pull`
 * does: through the file watcher.
 */
import { defineModule } from "@notefig/core";
import { GitError, isSshRemote, type GitBranchTarget, type GitDirection, type GitRemote, type GitService } from "@notefig/git";
import { gitWorkerModule, type GitWorker } from "@/modules/git-worker";
import { path as pathutil } from "@/utils/path";

declare module "@notefig/core" {
  interface WorkspaceModules {
    gitRemote: WorkspaceGitRemote;
  }
}

export interface WorkspaceGitRemote {
  /** The repositories this branch pushes to and pulls from that take a token. Rejects with why if there are none. */
  urls(): Promise<string[]>;
  /** Rejects with what to fix. `pushed` is false if the remote has it. */
  push(): Promise<{ branch: string; pushed: boolean }>;
  /** Fast-forward; how many files changed. Rejects with what to fix. */
  pull(): Promise<number>;
  dispose(): void;
}

/** What `ssh` is given to reach the remote: `ssh://[user@]host[:port]`, or `[user@]host` with an IPv6 host's brackets dropped. */
function sshDestinationOf(url: string): string {
  if (url.startsWith("ssh://")) return /^ssh:\/\/[^/]+/.exec(url)?.[0] ?? url;
  const scp = /^(?:([^@/:\s]+)@)?(?:\[([^\]\s]+)\]|([^:]+)):/.exec(url);
  if (!scp) return url;
  const host = scp[2] ?? scp[3];
  return scp[1] ? `${scp[1]}@${host}` : host;
}

/** What to do about a failed SSH session. Nothing here is about tokens. */
export function sshProblemOf(code: string, url: string): string | undefined {
  const where = url.replace(/^ssh:\/\//, "").replace(/\.git$/, "");
  const destination = sshDestinationOf(url);
  const problems: Record<string, string> = {
    AuthRequired: `SSH couldn't sign in to ${destination}. Add your key with ssh-add, then try again.`,
    AuthFailed: `Your SSH key can't write to ${where}.`,
    RepoNotFound: `${where} wasn't found, or your SSH key can't see it.`,
    HostUnverified: `This computer doesn't trust ${destination} yet. Run ssh -T ${destination} in a terminal and confirm its key.`,
    Network: `Couldn't reach ${where} over SSH. Check the connection and try again.`,
    UnsupportedOperation: "Notefig couldn't find the ssh command on this computer.",
  };
  return problems[code];
}

function problemOf(error: unknown, url: string): string {
  const sshProblem = error instanceof GitError && isSshRemote(url) ? sshProblemOf(error.code, url) : undefined;
  if (sshProblem) return sshProblem;
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
  let operation: Promise<void> = Promise.resolve();
  const service = () => (git ??= deps.gitWorker.create({ repoPath: root, gitDir }));

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = operation.then(work);
    operation = run.then(() => undefined, () => undefined);
    return run;
  };

  const target = async (direction: GitDirection): Promise<GitBranchTarget | { problem: string }> => {
    const found = await service().remoteTarget(direction);
    if ("url" in found && !/^https:\/\/[^/@\s]+\/\S+/.test(found.url) && !isSshRemote(found.url)) {
      return { problem: "Only HTTPS and SSH remotes are supported." };
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
      return await work({ name: found.remote, url: found.url, credential: root }, found);
    } catch (error) {
      throw new Error(problemOf(error, found.url));
    }
  };

  return {
    async urls() {
      const found = await Promise.all([target("push"), target("pull")]);
      const urls = found.flatMap((each) => ("url" in each ? [each.url] : []));
      if (urls.length === 0 && "problem" in found[0]) throw new Error(found[0].problem);
      const withTokens = urls.filter((url) => !isSshRemote(url));
      if (withTokens.length === 0) throw new Error("This remote signs in with your SSH keys, so it doesn't use a token.");
      return [...new Set(withTokens)];
    },
    push: () => exclusive(() =>
      onTarget("push", async (remote, found) => ({
        branch: found.branch,
        pushed: await service().pushBranch(remote, found),
      }))),
    pull: () => exclusive(() => onTarget("pull", (remote, found) => service().pullBranch(remote, found))),
    dispose() {
      if (git) deps.gitWorker.dispose(gitDir);
    },
  };
}

export const gitRemoteModule = defineModule({
  name: "gitRemote",
  needs: [gitWorkerModule],
  workspace: {
    create: (ctx) => createWorkspaceGitRemote({ workspacePath: ctx.workspace.path, gitWorker: ctx.use("gitWorker") }),
    dispose: (remote) => remote.dispose(),
  },
});
