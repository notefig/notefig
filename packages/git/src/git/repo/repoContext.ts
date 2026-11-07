import git, { type FsClient, type TreeEntry } from "isomorphic-git";

import type { GitStorageHost } from "../types";

/** What the repo-level helpers need from a service: its repo and storage. */
export interface RepoContext {
  /** Spread into every isomorphic-git call. */
  git: {
    fs: FsClient;
    dir: string;
    gitdir: string;
    cache: Record<string, unknown>;
  };
  host: GitStorageHost;
}

export function joinPath(base: string, relative: string): string {
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/${relative}`;
}

export function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** A tree's entries by name; an absent tree is empty. */
export async function treeEntries(
  ctx: RepoContext,
  oid?: string,
): Promise<Map<string, TreeEntry>> {
  if (!oid) return new Map();
  const { tree } = await git.readTree({ ...ctx.git, oid });
  return new Map(tree.map((entry) => [entry.path, entry]));
}
