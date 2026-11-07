/**
 * Three-way tree merge for `rebaseOnto`. Walks base/ours/theirs together,
 * pruning every subtree where one side is unchanged (that side's sibling
 * wins outright), so only files BOTH sides changed reach a file merge —
 * the injected `GitMergeDriver`, or git's line merge with conflict markers.
 */
import git, { type TreeEntry } from "isomorphic-git";

import type {
  GitConflict,
  GitMergeDriver,
  GitMergeHolder,
  GitMergedFile,
} from "../types";
import { lineMerge } from "./lineMerge";
import { treeEntries, type RepoContext } from "./repoContext";

type Entry = Pick<TreeEntry, "oid" | "mode" | "type">;

export interface TreeMergeState {
  /** The commit being replayed, for reporting. */
  commit: string;
  holder: GitMergeHolder;
  driver?: GitMergeDriver;
  merged: GitMergedFile[];
  conflicts: GitConflict[];
}

function same(a?: Entry, b?: Entry): boolean {
  if (!a || !b) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

async function readText(
  ctx: RepoContext,
  entry?: Entry,
): Promise<string | null | "binary"> {
  if (!entry) return null;
  const { blob } = await git.readBlob({ ...ctx.git, oid: entry.oid });
  if (blob.subarray(0, 8000).includes(0)) return "binary";
  return decoder.decode(blob);
}

async function blobEntry(
  ctx: RepoContext,
  text: string,
  mode: string,
): Promise<Entry> {
  const oid = await git.writeBlob({
    ...ctx.git,
    blob: new TextEncoder().encode(text),
  });
  return { oid, mode, type: "blob" };
}

function conflict(
  state: TreeMergeState,
  path: string,
  rest: Omit<GitConflict, "commit" | "path">,
): undefined {
  state.conflicts.push({ commit: state.commit, path, ...rest });
  return undefined;
}

type Sides = [Entry | undefined, Entry | undefined, Entry | undefined];
type Texts = [string | null, string | null, string | null];

/** Keep an executable-bit change from whichever side made it. */
function mergedMode([b, o, t]: Sides): string {
  if (o && o.mode !== b?.mode) return o.mode;
  return (t ?? o)!.mode;
}

async function withDriver(
  ctx: RepoContext,
  state: TreeMergeState,
  driver: GitMergeDriver,
  path: string,
  [base, ours, theirs]: Texts,
  mode: string,
): Promise<Entry | null | undefined> {
  const out = await driver.merge({
    path,
    base,
    ours,
    theirs,
    holder: state.holder,
  });
  if ("failed" in out)
    return conflict(state, path, { reason: "driver", message: out.failed });
  state.merged.push({
    commit: state.commit,
    path,
    overwritten: out.overwritten,
  });
  return out.content === null ? null : blobEntry(ctx, out.content, mode);
}

/** git's default: a line merge; markers or a delete/modify pair are a conflict. */
async function withLineMerge(
  ctx: RepoContext,
  state: TreeMergeState,
  path: string,
  [base, ours, theirs]: Texts,
  mode: string,
): Promise<Entry | null | undefined> {
  if (ours === null || theirs === null) {
    return conflict(state, path, { reason: "modify-delete" });
  }
  const result = lineMerge(base ?? "", ours, theirs);
  if (result.conflicted) {
    return conflict(state, path, {
      reason: "content",
      content: result.content,
    });
  }
  state.merged.push({ commit: state.commit, path, overwritten: [] });
  return blobEntry(ctx, result.content, mode);
}

/** A file both sides changed. `null` = deleted; `undefined` = conflict (recorded). */
async function mergeFile(
  ctx: RepoContext,
  state: TreeMergeState,
  path: string,
  sides: Sides,
): Promise<Entry | null | undefined> {
  const texts = await Promise.all(sides.map((e) => readText(ctx, e)));
  if (texts.includes("binary"))
    return conflict(state, path, { reason: "binary" });
  const mode = mergedMode(sides);
  return state.driver
    ? withDriver(ctx, state, state.driver, path, texts as Texts, mode)
    : withLineMerge(ctx, state, path, texts as Texts, mode);
}

async function mergeEntry(
  ctx: RepoContext,
  state: TreeMergeState,
  path: string,
  sides: Sides,
): Promise<Entry | null | undefined> {
  const [b, o, t] = sides;
  if (same(o, t) || same(t, b)) return o ?? null;
  if (same(o, b)) return t ?? null;
  const present = sides.filter((e): e is Entry => e !== undefined);
  if (present.every((e) => e.type === "tree")) {
    const oid = await mergeTrees(
      ctx,
      state,
      b?.oid,
      o?.oid,
      t?.oid,
      `${path}/`,
    );
    return oid === null ? null : { oid, mode: "040000", type: "tree" };
  }
  if (present.every((e) => e.type === "blob"))
    return mergeFile(ctx, state, path, sides);
  return conflict(state, path, {
    reason: "modify-delete",
    message: "a file on one side is a directory on the other",
  });
}

/**
 * Merge three trees (any may be missing). Resolves with the merged tree's
 * oid, or null when it came out empty below the root. Conflicts are
 * recorded on `state`; the returned oid is then meaningless.
 */
export async function mergeTrees(
  ctx: RepoContext,
  state: TreeMergeState,
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
  prefix = "",
): Promise<string | null> {
  const [b, o, t] = await Promise.all(
    [base, ours, theirs].map((oid) => treeEntries(ctx, oid)),
  );
  const names = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  const tree: TreeEntry[] = [];
  for (const name of names) {
    const entry = await mergeEntry(ctx, state, `${prefix}${name}`, [
      b.get(name),
      o.get(name),
      t.get(name),
    ]);
    if (entry) tree.push({ ...entry, path: name });
  }
  if (tree.length === 0 && prefix !== "") return null;
  return git.writeTree({ ...ctx.git, tree });
}
