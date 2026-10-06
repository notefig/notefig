import type { FileTree } from "@pierre/trees";
import { defineModule } from "@notefig/core";

/**
 * Memory of which directories are expanded, per open workspace —
 * `core.workspace(ws).treeExpansion`.
 *
 * The trees model lives and dies with the FileTree component (sidebar view
 * switches, sort-change remounts, workspace switches all unmount it), so
 * expansion state is mirrored here and replayed into the next model via
 * `initialExpandedPaths` / explicit expands. A workspace instance: a close
 * (or a restart) starts fresh, matching the previous tree's behavior.
 *
 * Paths are canonical workspace-relative (no trailing slash).
 */
export interface ExpansionMemory {
  /**
   * The remembered expanded set, or null if this workspace has never
   * mounted a tree (callers use null to fall back to the default initial
   * expansion).
   */
  paths(): string[] | null;
  isExpanded(canonicalPath: string): boolean;
  /**
   * Mirror the model's expansion state into the memory. Only rows
   * currently in the projection are touched: a directory hidden under a
   * collapsed ancestor keeps its remembered state, so re-expanding the
   * ancestor after a remount restores the whole shape. Returns the
   * unsubscribe function.
   */
  attach(model: FileTree): () => void;
}

export function createExpansionMemory(): ExpansionMemory {
  let expanded: Set<string> | null = null;
  return {
    paths: () => (expanded ? [...expanded] : null),
    isExpanded: (canonicalPath) => expanded?.has(canonicalPath) ?? false,
    attach(model) {
      const set = (expanded ??= new Set<string>());
      const record = () => {
        for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
          if (row.kind !== "directory") continue;
          const canonical = row.path.replace(/\/+$/, "");
          if (row.isExpanded) {
            set.add(canonical);
          } else {
            set.delete(canonical);
          }
        }
      };
      record();
      return model.subscribe(record);
    },
  };
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    treeExpansion: ExpansionMemory;
  }
}

export const treeExpansionModule = defineModule({
  name: "treeExpansion",
  workspace: { create: () => createExpansionMemory() },
});
