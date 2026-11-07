/**
 * Which objects a push must send: everything reachable from the new tips
 * that isn't reachable from what the remote already has. isomorphic-git's
 * own push sends every tree and blob of every new commit; this sends only
 * what changed, so a one-file edit is a one-blob pack (plus trees/commit).
 *
 * Commits: a date-ordered walk from both sides at once (git's "mark
 * uninteresting" walk), stopping once only uninteresting commits are
 * queued. Trees and blobs: walk the new commits' trees, pruning anything
 * the boundary (the haves, and the old parents of new commits) holds.
 */
import git from "isomorphic-git";

import { GitError } from "../types";
import type { RepoContext } from "./repoContext";

async function objectType(
  ctx: RepoContext,
  oid: string,
): Promise<string | null> {
  try {
    return (await git.readObject({ ...ctx.git, oid })).type;
  } catch {
    return null;
  }
}

interface Queued {
  oid: string;
  time: number;
}

class CommitWalk {
  readonly parents = new Map<string, string[]>();
  /** true = uninteresting (the remote has it). */
  private readonly flags = new Map<string, boolean>();
  private readonly queue: Queued[] = [];

  constructor(private readonly ctx: RepoContext) {}

  async add(oid: string, uninteresting: boolean): Promise<void> {
    const prior = this.flags.get(oid);
    if (prior === true || (prior === false && !uninteresting)) return;
    this.flags.set(oid, uninteresting);
    const { commit } = await git.readCommit({ ...this.ctx.git, oid });
    this.parents.set(oid, commit.parent);
    this.queue.push({ oid, time: commit.committer.timestamp });
    this.queue.sort((a, b) => a.time - b.time);
  }

  private pending(): boolean {
    return this.queue.some((entry) => this.flags.get(entry.oid) === false);
  }

  /** New commits: reachable from the tips, not from the haves. */
  async run(): Promise<{ commits: string[]; uninteresting: Set<string> }> {
    while (this.pending()) {
      const { oid } = this.queue.pop()!;
      const uninteresting = this.flags.get(oid) === true;
      for (const parent of this.parents.get(oid) ?? []) {
        // A parent missing locally (shallow history) ends that line.
        await this.add(parent, uninteresting).catch(() => undefined);
      }
    }
    const commits: string[] = [];
    const uninteresting = new Set<string>();
    for (const [oid, flag] of this.flags) {
      if (flag) uninteresting.add(oid);
      else commits.push(oid);
    }
    return { commits, uninteresting };
  }
}

async function addTree(
  ctx: RepoContext,
  oid: string,
  into: Set<string>,
  skip: Set<string>,
): Promise<void> {
  if (into.has(oid) || skip.has(oid)) return;
  into.add(oid);
  const { tree } = await git.readTree({ ...ctx.git, oid });
  for (const entry of tree) {
    if (entry.type === "tree") await addTree(ctx, entry.oid, into, skip);
    else if (entry.type === "blob" && !skip.has(entry.oid)) into.add(entry.oid);
  }
}

async function addCommitTree(
  ctx: RepoContext,
  oid: string,
  into: Set<string>,
  skip: Set<string>,
): Promise<void> {
  const { commit } = await git.readCommit({ ...ctx.git, oid });
  await addTree(ctx, commit.tree, into, skip);
}

/** Split oids by type; missing ones are dropped (haves) or fatal (tips). */
async function classify(ctx: RepoContext, oids: string[], required: boolean) {
  const commits: string[] = [];
  const others: string[] = [];
  for (const oid of oids) {
    const type = await objectType(ctx, oid);
    if (type === "commit") commits.push(oid);
    else if (type) others.push(oid);
    else if (required) {
      throw new GitError(
        "InvalidInput",
        `Cannot push ${oid}: no such object locally.`,
      );
    }
  }
  return { commits, others };
}

/** Oids to pack so a remote holding `haves` can accept `tips`. */
export async function objectsToPush(
  ctx: RepoContext,
  tips: string[],
  haves: string[],
): Promise<string[]> {
  const have = await classify(ctx, haves, false);
  const tip = await classify(ctx, tips, true);

  const walk = new CommitWalk(ctx);
  for (const oid of have.commits) await walk.add(oid, true);
  for (const oid of tip.commits) await walk.add(oid, false);
  const { commits, uninteresting } = await walk.run();

  // What the remote holds: the haves' trees, and the trees of old commits
  // that new commits build on directly.
  const known = new Set<string>(have.others);
  const boundary = new Set(have.commits);
  for (const oid of commits) {
    for (const parent of walk.parents.get(oid) ?? []) {
      if (uninteresting.has(parent)) boundary.add(parent);
    }
  }
  for (const oid of boundary) await addCommitTree(ctx, oid, known, new Set());

  const send = new Set<string>(commits);
  for (const oid of commits) await addCommitTree(ctx, oid, send, known);
  for (const oid of tip.others) await addNonCommit(ctx, oid, send, known);
  return [...send].filter((oid) => !known.has(oid));
}

async function addNonCommit(
  ctx: RepoContext,
  oid: string,
  send: Set<string>,
  known: Set<string>,
): Promise<void> {
  if (known.has(oid)) return;
  const { type, object } = await git.readObject({ ...ctx.git, oid });
  if (type === "tree") return addTree(ctx, oid, send, known);
  send.add(oid);
  if (type !== "tag") return;
  const target = (object as { object: string }).object;
  for (const dep of await objectsToPush(ctx, [target], [...known]))
    send.add(dep);
}
