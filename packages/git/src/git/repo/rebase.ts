/**
 * `rebaseOnto`: replay the current branch's own commits (first-parent,
 * oldest first) onto an upstream commit, like `git rebase`, but with
 * nothing left half-done: a conflict in any replay moves nothing. On
 * success the branch moves, the index follows, and each changed worktree
 * file is rewritten only if it still holds the old committed content —
 * an uncommitted edit is never clobbered (reported in `skippedDirty`).
 */
import git, { type CommitObject } from "isomorphic-git";

import {
  GitError,
  type GitMergeDriver,
  type GitRebaseOntoInput,
  type GitRebaseResult,
} from "../types";
import { joinPath, parentDir, type RepoContext } from "./repoContext";
import { mergeTrees, type TreeMergeState } from "./treeMerge";
import {
  diffTrees,
  sameVersion,
  type FileChange,
  type FileVersion,
} from "./treeDiff";

const OID = /^[0-9a-f]{40}$/;

export async function resolveCommitish(
  ctx: RepoContext,
  ref: string,
): Promise<string> {
  return OID.test(ref) ? ref : git.resolveRef({ ...ctx.git, ref });
}

interface Replay {
  oid: string;
  parentTree: string;
  commit: CommitObject;
}

async function treeOf(ctx: RepoContext, oid: string): Promise<string> {
  return (await git.readCommit({ ...ctx.git, oid })).commit.tree;
}

/**
 * The branch's own commits since `base`, oldest first. If `base` isn't on
 * the first-parent line (local merges), the whole range becomes one replay.
 */
async function localCommits(
  ctx: RepoContext,
  head: string,
  base: string,
): Promise<Replay[]> {
  const chain: Replay[] = [];
  let oid: string | undefined = head;
  while (oid && oid !== base) {
    const { commit }: { commit: CommitObject } = await git.readCommit({
      ...ctx.git,
      oid,
    });
    const parent: string | undefined = commit.parent[0];
    if (!parent) {
      const headCommit = (await git.readCommit({ ...ctx.git, oid: head }))
        .commit;
      return [
        { oid: head, parentTree: await treeOf(ctx, base), commit: headCommit },
      ];
    }
    chain.push({ oid, parentTree: await treeOf(ctx, parent), commit });
    oid = parent;
  }
  return chain.reverse();
}

function replayedCommit(
  replay: Replay,
  tree: string,
  parent: string,
): CommitObject {
  const { author, committer, message } = replay.commit;
  return {
    tree,
    parent: [parent],
    author,
    committer: { ...committer, timestamp: Math.floor(Date.now() / 1000) },
    message,
  };
}

async function replayAll(
  ctx: RepoContext,
  replays: Replay[],
  onto: string,
  base: Omit<TreeMergeState, "commit" | "merged" | "conflicts">,
): Promise<GitRebaseResult> {
  let tip = onto;
  let tipTree = await treeOf(ctx, onto);
  let replayed = 0;
  const merged: TreeMergeState["merged"] = [];
  for (const replay of replays) {
    const state: TreeMergeState = {
      ...base,
      commit: replay.oid,
      merged,
      conflicts: [],
    };
    const tree = await mergeTrees(
      ctx,
      state,
      replay.parentTree,
      replay.commit.tree,
      tipTree,
    );
    if (state.conflicts.length > 0)
      return { status: "conflicted", conflicts: state.conflicts };
    if (tree === tipTree) continue;
    tip = await git.writeCommit({
      ...ctx.git,
      commit: replayedCommit(replay, tree!, tip),
    });
    tipTree = tree!;
    replayed += 1;
  }
  return { status: "rebased", oid: tip, replayed, merged, skippedDirty: [] };
}

const SYMLINK = "120000";
const EXECUTABLE = "100755";

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A worktree file's bytes; a symlink's are its target, as git stores it. */
async function readWorktree(
  ctx: RepoContext,
  path: string,
): Promise<Uint8Array | null> {
  const full = joinPath(ctx.git.dir, path);
  const stat = await ctx.host.lstat(full);
  if (stat.isSymbolicLink)
    return new TextEncoder().encode(await ctx.host.readLink(full));
  return stat.exists && stat.isFile ? ctx.host.readFile(full) : null;
}

async function readBlobAt(
  ctx: RepoContext,
  oid?: string,
): Promise<Uint8Array | null> {
  return oid ? (await git.readBlob({ ...ctx.git, oid })).blob : null;
}

/** The index's entry for each of `paths` that it holds. */
async function stagedVersions(
  ctx: RepoContext,
  paths: string[],
): Promise<Map<string, FileVersion>> {
  const wanted = new Set(paths);
  const dirs = new Set(paths.flatMap(ancestors));
  const staged = new Map<string, FileVersion>();
  await git.walk({
    ...ctx.git,
    trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (entry && wanted.has(filepath) && (await entry.type()) === "blob") {
        const mode = (await entry.mode()).toString(8);
        staged.set(filepath, { oid: await entry.oid(), mode });
      }
      return filepath === "." || dirs.has(filepath) ? true : null;
    },
  });
  return staged;
}

function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Whether the worktree file at `change.path` still holds `from`'s content. */
async function worktreeClean(
  ctx: RepoContext,
  change: FileChange,
): Promise<boolean> {
  const onDisk = await readWorktree(ctx, change.path);
  return bytesEqual(onDisk, await readBlobAt(ctx, change.from?.oid));
}

/** A symlink, where the host has them (else a file holding the target, as git does). */
async function createSymlink(
  ctx: RepoContext,
  full: string,
  blob: Uint8Array,
): Promise<boolean> {
  if ((await ctx.host.lstat(full)).exists) await ctx.host.deleteFile(full);
  return ctx.host
    .createSymlink(new TextDecoder().decode(blob), full)
    .then(() => true)
    .catch(() => false);
}

/** Write `version` at `full`, with its exec bit where the host supports chmod. */
async function writeVersion(
  ctx: RepoContext,
  full: string,
  version: FileVersion,
): Promise<void> {
  const blob = (await readBlobAt(ctx, version.oid))!;
  await ctx.host.createDir(parentDir(full));
  if (version.mode === SYMLINK && (await createSymlink(ctx, full, blob)))
    return;
  await ctx.host.writeFileAtomic(full, blob);
  if (version.mode === EXECUTABLE)
    await ctx.host.chmod(full, 0o755).catch(() => undefined);
}

/**
 * Point the index entry at `to`. `resetIndex` takes the mode from the
 * worktree file, which is wrong for a symlink, or an exec bit the host
 * couldn't set, so a non-regular mode is written from the tree.
 */
async function updateIndexEntry(
  ctx: RepoContext,
  change: FileChange,
  to: string,
): Promise<void> {
  // Not resetIndex: where the path became a folder it would stage the tree.
  if (!change.to) {
    await git.updateIndex({
      ...ctx.git,
      filepath: change.path,
      remove: true,
      force: true,
    });
    return;
  }
  await git.resetIndex({ ...ctx.git, filepath: change.path, ref: to });
  if (change.to.mode !== "100644") {
    await git.updateIndex({
      ...ctx.git,
      filepath: change.path,
      oid: change.to.oid,
      mode: Number.parseInt(change.to.mode, 8),
      add: true,
    });
  }
}

interface CheckoutPlan {
  remove: FileChange[];
  write: FileChange[];
  /** Changes whose index entry follows `to` (the index held `from`). */
  index: FileChange[];
  /** Paths with uncommitted work, or in the way of one: left alone. */
  skipped: string[];
}

async function planCheckout(
  ctx: RepoContext,
  changes: FileChange[],
): Promise<CheckoutPlan> {
  const staged = await stagedVersions(
    ctx,
    changes.map((c) => c.path),
  );
  const plan: CheckoutPlan = { remove: [], write: [], index: [], skipped: [] };
  for (const change of changes) {
    // A staged edit is uncommitted work too: leave index and file alone.
    const indexClean = sameVersion(staged.get(change.path), change.from);
    if (indexClean) plan.index.push(change);
    if (!indexClean || !(await worktreeClean(ctx, change))) {
      plan.skipped.push(change.path);
    } else if (change.to) {
      plan.write.push(change);
    } else {
      plan.remove.push(change);
    }
  }
  return plan;
}

/** Delete a file, then each folder above it that this leaves empty. */
async function removeFile(ctx: RepoContext, path: string): Promise<void> {
  await ctx.host.deleteFile(joinPath(ctx.git.dir, path));
  for (const dir of ancestors(path).reverse()) {
    const full = joinPath(ctx.git.dir, dir);
    if ((await ctx.host.readDir(full)).length > 0) return;
    await ctx.host.removeDir(full);
  }
}

/** A folder sits at `path`, or a file where one of its folders goes. */
async function blocked(ctx: RepoContext, path: string): Promise<boolean> {
  if ((await ctx.host.lstat(joinPath(ctx.git.dir, path))).isDir) return true;
  for (const dir of ancestors(path)) {
    const stat = await ctx.host.lstat(joinPath(ctx.git.dir, dir));
    if (stat.exists && !stat.isDir) return true;
  }
  return false;
}

/**
 * Bring index and clean worktree files from commit `from` to `to`.
 * Removals go first, so the path a deletion frees (a file becoming a
 * folder, or a folder a file) is free when the write needs it.
 */
async function updateWorktree(
  ctx: RepoContext,
  from: string,
  to: string,
): Promise<string[]> {
  const changes = await diffTrees(
    ctx,
    await treeOf(ctx, from),
    await treeOf(ctx, to),
  );
  const plan = await planCheckout(ctx, changes);
  for (const change of plan.remove) await removeFile(ctx, change.path);
  for (const change of plan.write) {
    if (await blocked(ctx, change.path)) plan.skipped.push(change.path);
    else
      await writeVersion(ctx, joinPath(ctx.git.dir, change.path), change.to!);
  }
  const removalsFirst = (c: FileChange) => (c.to ? 1 : 0);
  plan.index.sort((a, b) => removalsFirst(a) - removalsFirst(b));
  for (const change of plan.index) await updateIndexEntry(ctx, change, to);
  return plan.skipped;
}

async function moveBranch(
  ctx: RepoContext,
  branch: string,
  from: string,
  to: string,
) {
  const current = await git.resolveRef({ ...ctx.git, ref: branch });
  if (current !== from) {
    throw new GitError(
      "LockUnavailable",
      `${branch} moved during rebaseOnto; retry.`,
    );
  }
  await git.writeRef({ ...ctx.git, ref: branch, value: to, force: true });
}

export async function rebaseOnto(
  ctx: RepoContext,
  driver: GitMergeDriver | undefined,
  input: GitRebaseOntoInput,
): Promise<GitRebaseResult> {
  const branch = await git.currentBranch({ ...ctx.git, fullname: true });
  if (!branch)
    throw new GitError(
      "InvalidInput",
      "rebaseOnto needs a checked-out branch.",
    );
  const ours = await git.resolveRef({ ...ctx.git, ref: branch });
  const theirs = await resolveCommitish(ctx, input.theirs);
  const [base] = await git.findMergeBase({ ...ctx.git, oids: [ours, theirs] });
  if (!base) return { status: "unrelated" };
  if (base === theirs) return { status: "up-to-date", oid: ours };

  let result: GitRebaseResult;
  if (base === ours) {
    result = { status: "fast-forward", oid: theirs, skippedDirty: [] };
  } else {
    const replays = await localCommits(ctx, ours, base);
    result = await replayAll(ctx, replays, theirs, {
      holder: input.holder ?? "theirs",
      driver,
    });
  }
  if (result.status !== "fast-forward" && result.status !== "rebased")
    return result;
  await moveBranch(ctx, branch, ours, result.oid);
  result.skippedDirty = await updateWorktree(ctx, ours, result.oid);
  return result;
}
