import type { TreeEntry } from "isomorphic-git";

import { treeEntries, type RepoContext } from "./repoContext";

/** A file's blob and mode (`100644`, `100755` or `120000` for a symlink). */
export interface FileVersion {
  oid: string;
  mode: string;
}

export interface FileChange {
  path: string;
  /** Absent when the file was added. */
  from?: FileVersion;
  /** Absent when the file was deleted. */
  to?: FileVersion;
}

const subtree = (entry?: TreeEntry) =>
  entry?.type === "tree" ? entry.oid : undefined;
const blob = (entry?: TreeEntry): FileVersion | undefined =>
  entry?.type === "blob" ? { oid: entry.oid, mode: entry.mode } : undefined;
export const sameVersion = (a?: FileVersion, b?: FileVersion) =>
  a?.oid === b?.oid && a?.mode === b?.mode;

/** Files whose blob or mode differs between two trees, skipping identical subtrees. */
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
    if (l?.oid === r?.oid && l?.type === r?.type && l?.mode === r?.mode)
      continue;
    const path = `${prefix}${name}`;
    changes.push(...(await diffTrees(ctx, subtree(l), subtree(r), `${path}/`)));
    const from = blob(l);
    const to = blob(r);
    if (!sameVersion(from, to)) changes.push({ path, from, to });
  }
  return changes;
}
