import { useEffect } from "react";
import { hydrateDirectoryStats } from "@/entities/files";

interface HydratableNode {
  path: string;
  type: "file" | "directory";
  children?: unknown[];
}

/**
 * Stats a directory's children once the tree is actually showing them —
 * the read side of lazy metadata hydration (rows arrive from the listing
 * walk with no modified/size).
 *
 * Re-runs when the child count changes so rows that appear after the
 * initial listing (watcher inserts, renames) get stats too. Hydration is
 * idempotent and coalesces per directory, so an extra call is cheap.
 */
export function useDirectoryStatHydration(
  workspacePath: string,
  node: HydratableNode,
  isExpanded: boolean,
): void {
  const shouldHydrate = node.type === "directory" && isExpanded;
  const childCount = node.children?.length ?? 0;
  const dirPath = node.path;

  useEffect(() => {
    if (!shouldHydrate) return;
    hydrateDirectoryStats(workspacePath, dirPath).catch((error: unknown) => {
      console.warn(`Failed to hydrate stats for ${dirPath}:`, error);
    });
  }, [workspacePath, dirPath, shouldHydrate, childCount]);
}
