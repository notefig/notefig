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
import { diffTrees } from "./treeDiff";

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

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function readWorktree(
  ctx: RepoContext,
  path: string,
): Promise<Uint8Array | null> {
  const full = joinPath(ctx.git.dir, path);
  const stat = await ctx.host.stat(full);
  return stat.exists && stat.isFile ? ctx.host.readFile(full) : null;
}

async function readBlobAt(
  ctx: RepoContext,
  oid?: string,
): Promise<Uint8Array | null> {
  return oid ? (await git.readBlob({ ...ctx.git, oid })).blob : null;
}

/** Bring index and clean worktree files from commit `from` to `to`. */
async function updateWorktree(
  ctx: RepoContext,
  from: string,
  to: string,
): Promise<string[]> {
  const skipped: string[] = [];
  const changes = await diffTrees(
    ctx,
    await treeOf(ctx, from),
    await treeOf(ctx, to),
  );
  for (const change of changes) {
    const full = joinPath(ctx.git.dir, change.path);
    const onDisk = await readWorktree(ctx, change.path);
    if (!bytesEqual(onDisk, await readBlobAt(ctx, change.from))) {
      skipped.push(change.path);
    } else if (change.to) {
      await ctx.host.createDir(parentDir(full));
      await ctx.host.writeFileAtomic(full, (await readBlobAt(ctx, change.to))!);
    } else if (onDisk) {
      await ctx.host.deleteFile(full);
    }
    await git.resetIndex({ ...ctx.git, filepath: change.path, ref: to });
  }
  return skipped;
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
