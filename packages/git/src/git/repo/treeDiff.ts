import type { TreeEntry } from "isomorphic-git";

import { treeEntries, type RepoContext } from "./repoContext";

export interface FileChange {
  path: string;
  /** Blob oid before; absent when the file was added. */
  from?: string;
  /** Blob oid after; absent when the file was deleted. */
  to?: string;
}

const subtree = (entry?: TreeEntry) =>
  entry?.type === "tree" ? entry.oid : undefined;
const blob = (entry?: TreeEntry) =>
  entry?.type === "blob" ? entry.oid : undefined;

/** Files that differ between two trees, skipping identical subtrees. */
export async function diffTrees(
  ctx: RepoContext,
  a: string | undefined,
  b: string | undefined,
  prefix = "",
): Promise<FileChange[]> {
  if (a === b) return [];
  const [left, right] = await Promise.all([
    treeEntries(ctx, a),
    treeEntries(ctx, b),
  ]);
  const changes: FileChange[] = [];
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const l = left.get(name);
    const r = right.get(name);
    if (l?.oid === r?.oid && l?.type === r?.type) continue;
    const path = `${prefix}${name}`;
    changes.push(...(await diffTrees(ctx, subtree(l), subtree(r), `${path}/`)));
    const from = blob(l);
    const to = blob(r);
    if (from !== to) changes.push({ path, from, to });
  }
  return changes;
}
