import type { FileTree } from "@pierre/trees";

/**
 * Lazy metadata hydration (MET-99) for the trees-based file tree: stat a
 * directory's children once the tree is actually showing them (the read
 * side of lazy hydration — rows arrive from the listing walk with no
 * modified/size).
 *
 * The projected row count changes on every expand/collapse and structural
 * mutation, so it doubles as the change signal; notifications that keep the
 * count stable (focus moves, selection) are skipped. Hydration skips
 * directories already hydrated and coalesces per directory, so
 * re-requesting the visible ones is cheap.
 *
 * Returns the unsubscribe function.
 */
export function attachTreeStatHydration(
  model: FileTree,
  /** The workspace's files: its root, and the stat hydration of its rows. */
  files: {
    workspacePath: string;
    hydrateDirectoryStats(dirPaths: readonly string[]): Promise<void>;
  },
  toAbs: (relPath: string) => string,
): () => void {
  const { workspacePath, hydrateDirectoryStats } = files;
  let lastCount = -1;

  const hydrateVisibleDirs = () => {
    const count = model.getVisibleCount();
    if (count === lastCount) return;
    lastCount = count;
    // Root-level rows aren't inside any expandable directory — the root is
    // always "expanded". One request for all of them: one stat batch.
    const dirs = [workspacePath];
    for (const row of model.getVisibleRows(0, count)) {
      if (row.kind === "directory" && row.isExpanded) dirs.push(toAbs(row.path));
    }
    hydrateDirectoryStats(dirs).catch((error: unknown) => {
      console.warn("Failed to hydrate directory stats:", error);
    });
  };

  hydrateVisibleDirs();
  return model.subscribe(hydrateVisibleDirs);
}
