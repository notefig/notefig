/**
 * `core.workspace(ws).gitRemote`: pushing the checked-out branch to its
 * remote, and pulling from it, when asked (the command palette). Nothing
 * runs otherwise: the git worker boots on the first call.
 *
 * A pull only ever fast-forwards, and refuses before moving anything if a
 * file it would change has local edits, saved or not.
 */
import { defineModule } from "@notefig/core";
import { GitError, type GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import { documentsModule, type DocumentsApi } from "@/modules/documents";
import { filesModule, type WorkspaceFiles } from "@/modules/files";
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
  /** The branch and remote these use, or why there are none. */
  target(): Promise<GitRemoteTarget | { problem: string }>;
  /** Push the checked-out branch, only ever forward; `pushed` is false
   *  when the remote already had it. Rejects with what to fix. */
  push(): Promise<{ branch: string; pushed: boolean }>;
  /** Fast-forward the checked-out branch; how many files changed. Rejects
   *  with what to fix. */
  pull(): Promise<number>;
  dispose(): void;
}

export interface GitRemoteDeps {
  workspacePath: string;
  fs: Pick<FileSystemSurface, "writeBinaryFiles" | "deleteFiles">;
  gitWorker: GitWorker;
  documents: Pick<DocumentsApi, "write" | "hasUnsavedEdits">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
}

const REJECTED = new Set(["NotFastForward", "RefConflict", "PushRejected"]);

function problemOf(error: unknown, url: string): string {
  const where = url.replace(/^https:\/\//, "").replace(/\.git$/, "");
  const code = error instanceof GitError ? error.code : "";
  if (code === "AuthRequired") return `No credentials work for ${where}. Run "Git: Use a Token for This Remote".`;
  if (code === "AuthFailed") return `These credentials can't access ${where}. It needs write access to its contents.`;
  if (code === "RepoNotFound") return `${where} wasn't found, or these credentials can't see it.`;
  if (code === "Network") return `Couldn't reach ${new URL(url).host}. Check the connection and try again.`;
  if (code === "Throttled") return "The host is rate limiting requests. Try again in a minute.";
  if (REJECTED.has(code)) return "The remote has commits this branch doesn't. Pull them first, then push.";
  return error instanceof Error ? error.message : String(error);
}

function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function listed(paths: string[]): string {
  return paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ");
}

export function createWorkspaceGitRemote(deps: GitRemoteDeps): WorkspaceGitRemote {
  const root = pathutil.normalize(deps.workspacePath);
  const gitDir = pathutil.join(root, ".git");
  let git: GitService | null = null;
  const service = () => (git ??= deps.gitWorker.create({ repoPath: root, gitDir }));
  const absolute = (path: string) => pathutil.join(root, pathutil.fromTreePath(path));

  const target = async (): Promise<GitRemoteTarget | { problem: string }> => {
    try {
      const branch = await service().currentBranch();
      if (!branch) return { problem: "Check out a branch first." };
      const name = (await service().getConfig(`branch.${branch}.remote`)) ?? "origin";
      const url = await service().getConfig(`remote.${name}.url`);
      if (!url) return { problem: `This repository has no remote for ${branch}.` };
      if (!/^https:\/\/[^/@\s]+\/\S+/.test(url)) return { problem: "Only HTTPS remotes are supported for now." };
      return { url, branch };
    } catch {
      return { problem: "This folder isn't a git repository." };
    }
  };

  /** Run `work` on the target, its failures said in the user's terms. */
  const onTarget = async <T>(work: (found: GitRemoteTarget, ref: string) => Promise<T>): Promise<T> => {
    const found = await target();
    if ("problem" in found) throw new Error(found.problem);
    try {
      return await work(found, `refs/heads/${found.branch}`);
    } catch (error) {
      throw new Error(problemOf(error, found.url));
    }
  };

  const head = async (ref: string) => (await service().log({ ref, depth: 1 }).catch(() => []))[0]?.oid ?? null;

  /** Throw if a file a pull would change has local edits. */
  const refuseOverLocalEdits = async (paths: string[]) => {
    const unsaved = paths.filter((path) => deps.documents.hasUnsavedEdits(absolute(path)));
    const status = await service().status({ filepaths: paths });
    const changed = [...status.staged, ...status.unstaged].map((change) => change.path).concat(status.untracked);
    const blocked = [...new Set([...unsaved, ...changed])];
    if (blocked.length > 0) throw new Error(`Local changes in ${listed(blocked)} would be overwritten. Commit them first.`);
  };

  /** Bring the index and worktree to `to` for `paths`, through the
   *  documents path so open editors follow. */
  const applyChanges = async (paths: string[], to: string) => {
    const created: string[] = [];
    const deleted: string[] = [];
    for (const filepath of paths) {
      const bytes = await service().readFile({ ref: to, filepath });
      await service().unstage({ filepath, ref: to });
      const path = absolute(filepath);
      if (bytes === null) {
        await deps.fs.deleteFiles([path]);
        deleted.push(path);
        continue;
      }
      const text = asText(bytes);
      if (text === null) await deps.fs.writeBinaryFiles([{ path, data: bytes }]);
      else await deps.documents.write(path, text);
      created.push(path);
    }
    await deps.files.recordDiskChanges({ created, deleted });
  };

  return {
    target,
    push: () =>
      onTarget(async ({ url, branch }, ref) => {
        const ours = await head(ref);
        if (!ours) throw new Error("This branch has no commits yet.");
        const refs = await service().listRemoteRefs({ url }, [ref]);
        const theirs = refs.find((entry) => entry.ref === ref)?.oid ?? null;
        if (theirs === ours) return { branch, pushed: false };
        await service().pushRef({ url }, { ref, oid: ours, expect: theirs });
        return { branch, pushed: true };
      }),
    pull: () =>
      onTarget(async ({ url, branch }, ref) => {
        const [fetched] = await service().fetchRefs({ url }, [ref]);
        const theirs = fetched?.oid;
        if (!theirs) throw new Error(`The remote has no branch ${branch}.`);
        const ours = await head(ref);
        if (!ours) throw new Error("This branch has no commits yet.");
        if (ours === theirs) return 0;
        const base = await service().mergeBase(ours, theirs);
        if (base === theirs) return 0;
        if (base !== ours) throw new Error("This branch and the remote have both moved. Merge them in a terminal.");
        const paths = await service().changedFiles(ours, theirs);
        await refuseOverLocalEdits(paths);
        await service().merge({ ours: ref, theirs, fastForwardOnly: true });
        await applyChanges(paths, theirs);
        return paths.length;
      }),
    dispose() {
      if (git) deps.gitWorker.dispose(gitDir);
    },
  };
}

export const gitRemoteModule = defineModule({
  name: "gitRemote",
  needs: [platformModule, documentsModule, gitWorkerModule],
  workspace: {
    needs: [filesModule],
    create: (ctx) =>
      createWorkspaceGitRemote({
        workspacePath: ctx.workspace.path,
        fs: ctx.use("platform").fs,
        gitWorker: ctx.use("gitWorker"),
        documents: ctx.use("documents"),
        files: ctx.useWorkspace("files"),
      }),
    dispose: (remote) => remote.dispose(),
  },
});
