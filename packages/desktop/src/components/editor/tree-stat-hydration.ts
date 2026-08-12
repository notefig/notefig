import type { FileTree } from "@pierre/trees";
import { hydrateDirectoryStats } from "@/entities/files";

/**
 * Lazy metadata hydration (MET-99) for the trees-based file tree: stat a
 * directory's children once the tree is actually showing them (the read
 * side of lazy hydration — rows arrive from the listing walk with no
 * modified/size).
 *
 * The projected row count changes on every expand/collapse and structural
 * mutation, so it doubles as the change signal; notifications that keep the
 * count stable (focus moves, selection) are skipped. Hydration is idempotent
 * and coalesces per directory, so re-requesting visible dirs is cheap.
 *
 * Returns the unsubscribe function.
 */
export function attachTreeStatHydration(
  model: FileTree,
  workspacePath: string,
  toAbs: (relPath: string) => string,
): () => void {
  let lastCount = -1;

  const hydrate = (dirPath: string) => {
    hydrateDirectoryStats(workspacePath, dirPath).catch((error: unknown) => {
      console.warn(`Failed to hydrate stats for ${dirPath}:`, error);
    });
  };

  const hydrateVisibleDirs = () => {
    const count = model.getVisibleCount();
    if (count === lastCount) return;
    lastCount = count;
    // Root-level rows aren't inside any expandable directory — the root is
    // always "expanded".
    hydrate(workspacePath);
    for (const row of model.getVisibleRows(0, count)) {
      if (row.kind === "directory" && row.isExpanded) {
        hydrate(toAbs(row.path));
      }
    }
  };

  hydrateVisibleDirs();
  return model.subscribe(hydrateVisibleDirs);
}
