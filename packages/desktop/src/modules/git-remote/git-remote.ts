/**
 * `core.workspace(ws).gitRemote`: pushing the checked-out branch to its
 * remote, and pulling from it, when asked (the command palette). Nothing
 * runs otherwise: the git worker boots on the first call.
 *
 * A pull only ever fast-forwards, and refuses before moving anything if a
 * file it would change differs from the last commit, saved or not. It
 * writes the files first and moves the branch last; if a write fails, the
 * files go back and the branch stays.
 */
import { defineModule } from "@notefig/core";
import { GitError, type GitRemote, type GitService } from "@notefig/git";
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

/** Where a push or pull of the checked-out branch goes. */
export interface GitRemoteTarget {
  url: string;
  branch: string;
  /** The branch's name on the remote (`refs/heads/…`). */
  remoteRef: string;
}

type Direction = "push" | "pull";

/** One file a pull changes; null where it doesn't exist. */
interface PullChange {
  filepath: string;
  before: Uint8Array | null;
  after: Uint8Array | null;
}

export interface WorkspaceGitRemote {
  /** Where a push (the default) or pull goes, or why it can't. */
  target(direction?: Direction): Promise<GitRemoteTarget | { problem: string }>;
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
  fs: Pick<FileSystemSurface, "readBinaryFiles" | "writeBinaryFiles" | "deleteFiles">;
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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
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

  const config = (path: string) => service().getConfig(path);

  /** The remote's name and URL for this direction, as git picks them. */
  const pickRemote = async (branch: string, direction: Direction, tracking: string | undefined) => {
    if (direction === "pull") {
      const name = tracking ?? "origin";
      return { name, url: await config(`remote.${name}.url`) };
    }
    const name = (await config(`branch.${branch}.pushRemote`)) ?? (await config("remote.pushDefault")) ?? tracking ?? "origin";
    return { name, url: (await config(`remote.${name}.pushurl`)) ?? (await config(`remote.${name}.url`)) };
  };

  const target = async (direction: Direction = "push"): Promise<GitRemoteTarget | { problem: string }> => {
    try {
      const branch = await service().currentBranch();
      if (!branch) return { problem: "Check out a branch first." };
      const tracking = await config(`branch.${branch}.remote`);
      const { name, url } = await pickRemote(branch, direction, tracking);
      if (!url) return { problem: `This repository has no remote for ${branch}.` };
      if (!/^https:\/\/[^/@\s]+\/\S+/.test(url)) return { problem: "Only HTTPS remotes are supported for now." };
      const own = `refs/heads/${branch}`;
      const upstream = (await config(`branch.${branch}.merge`)) ?? own;
      if (direction === "pull") return { url, branch, remoteRef: upstream };
      // As git's default does: it won't push to a differently named upstream.
      if (name === tracking && upstream !== own) {
        return { problem: `${branch} tracks a branch with another name. Push it from a terminal.` };
      }
      return { url, branch, remoteRef: own };
    } catch {
      return { problem: "This folder isn't a git repository." };
    }
  };

  /** Run `work` on the target, its failures said in the user's terms. */
  const onTarget = async <T>(
    direction: Direction,
    work: (found: GitRemoteTarget, remote: GitRemote, ref: string) => Promise<T>,
  ): Promise<T> => {
    const found = await target(direction);
    if ("problem" in found) throw new Error(found.problem);
    try {
      return await work(found, { url: found.url, credential: root }, `refs/heads/${found.branch}`);
    } catch (error) {
      throw new Error(problemOf(error, found.url));
    }
  };

  const head = async (ref: string) => (await service().log({ ref, depth: 1 }).catch(() => []))[0]?.oid ?? null;

  /** Every file's two versions, before anything moves. */
  const readChanges = async (paths: string[], ours: string, theirs: string): Promise<PullChange[]> => {
    const changes: PullChange[] = [];
    for (const filepath of paths) {
      try {
        const before = await service().readFile({ ref: ours, filepath });
        changes.push({ filepath, before, after: await service().readFile({ ref: theirs, filepath }) });
      } catch {
        throw new Error(`${filepath} changed between a file and a folder. Pull it in a terminal.`);
      }
    }
    return changes;
  };

  /** Whether the file is no longer what the last commit has. */
  const hasLocalEdits = async ({ filepath, before }: PullChange): Promise<boolean> => {
    const path = absolute(filepath);
    if (deps.documents.hasUnsavedEdits(path)) return true;
    const { succeeded, failed } = await deps.fs.readBinaryFiles([path]);
    if (failed[0] && failed[0].type !== "not_found") return true;
    return !sameBytes(succeeded[0]?.data ?? null, before);
  };

  const localEditsError = (paths: string[]) =>
    new Error(`Local changes in ${listed(paths)} would be overwritten. Commit them first.`);

  const refuseOverLocalEdits = async (changes: PullChange[]) => {
    const blocked: string[] = [];
    for (const change of changes) if (await hasLocalEdits(change)) blocked.push(change.filepath);
    if (blocked.length > 0) throw localEditsError(blocked);
  };

  /** Put one version on disk, through documents so open editors follow. */
  const writeVersion = async (filepath: string, bytes: Uint8Array | null) => {
    const path = absolute(filepath);
    const text = bytes && asText(bytes);
    const { failed } =
      bytes === null
        ? await deps.fs.deleteFiles([path])
        : text === null
          ? await deps.fs.writeBinaryFiles([{ path, data: bytes }])
          : (await deps.documents.write(path, text), { failed: [] as { message: string }[] });
    if (failed[0]) throw new Error(`Couldn't update ${filepath}: ${failed[0].message}`);
  };

  /** The files, then the branch; a failure puts the files back. */
  const applyChanges = async (changes: PullChange[], ref: string, theirs: string) => {
    const done: PullChange[] = [];
    try {
      for (const change of changes) {
        // Typing may have landed since the check before this began.
        if (await hasLocalEdits(change)) throw localEditsError([change.filepath]);
        await writeVersion(change.filepath, change.after);
        done.push(change);
      }
      await service().merge({ ours: ref, theirs, fastForwardOnly: true });
    } catch (error) {
      for (const change of done) await writeVersion(change.filepath, change.before).catch(() => {});
      throw error;
    }
    for (const { filepath } of changes) await service().unstage({ filepath, ref: theirs });
    const paths = (present: boolean) =>
      changes.filter((change) => (change.after !== null) === present).map((change) => absolute(change.filepath));
    await deps.files.recordDiskChanges({ created: paths(true), deleted: paths(false) });
  };

  return {
    target,
    push: () =>
      onTarget("push", async ({ branch }, remote, ref) => {
        const ours = await head(ref);
        if (!ours) throw new Error("This branch has no commits yet.");
        const refs = await service().listRemoteRefs(remote, [ref]);
        const theirs = refs.find((entry) => entry.ref === ref)?.oid ?? null;
        if (theirs === ours) return { branch, pushed: false };
        await service().pushRef(remote, { ref, oid: ours, expect: theirs });
        return { branch, pushed: true };
      }),
    pull: () =>
      onTarget("pull", async ({ remoteRef }, remote, ref) => {
        const [fetched] = await service().fetchRefs(remote, [remoteRef]);
        const theirs = fetched?.oid;
        if (!theirs) throw new Error(`The remote has no ${remoteRef.replace("refs/heads/", "")} branch.`);
        const ours = await head(ref);
        if (!ours) throw new Error("This branch has no commits yet.");
        if (ours === theirs) return 0;
        const base = await service().mergeBase(ours, theirs);
        if (base === theirs) return 0;
        if (base !== ours) throw new Error("This branch and the remote have both moved. Merge them in a terminal.");
        const differences = await service().changedFiles(ours, theirs);
        const modes = differences.filter((difference) => difference.modeChanged).map((difference) => difference.path);
        if (modes.length > 0) throw new Error(`File permissions changed in ${listed(modes)}. Pull it in a terminal.`);
        const changes = await readChanges(differences.map((difference) => difference.path), ours, theirs);
        await refuseOverLocalEdits(changes);
        await applyChanges(changes, ref, theirs);
        return changes.length;
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
