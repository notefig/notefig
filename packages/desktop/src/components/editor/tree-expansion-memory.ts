import type { FileTree } from "@pierre/trees";
import { workspaceScoped } from "@/entities/workspace-scoped";

/**
 * Memory of which directories are expanded, per open workspace.
 *
 * The trees model lives and dies with the FileTree component (sidebar view
 * switches, sort-change remounts, workspace switches all unmount it), so
 * expansion state is mirrored here and replayed into the next model via
 * `initialExpandedPaths` / explicit expands. Scoped to the workspace being
 * open: a close (or a restart) starts fresh, matching the previous tree's
 * behavior.
 *
 * Paths are canonical workspace-relative (no trailing slash).
 */
const expansion = workspaceScoped({ create: () => new Set<string>() });

/**
 * The remembered expanded set, or null if this workspace has never mounted
 * a tree (callers use null to fall back to the default initial expansion).
 */
export function rememberedExpandedPaths(
  workspacePath: string,
): string[] | null {
  const set = expansion.peek(workspacePath);
  return set ? [...set] : null;
}

export function isRememberedExpanded(
  workspacePath: string,
  canonicalPath: string,
): boolean {
  return expansion.peek(workspacePath)?.has(canonicalPath) ?? false;
}

/**
 * Mirror the model's expansion state into the store. Only rows currently in
 * the projection are touched: a directory hidden under a collapsed ancestor
 * keeps its remembered state, so re-expanding the ancestor after a remount
 * restores the whole shape. Returns the unsubscribe function.
 */
export function attachExpansionMemory(
  model: FileTree,
  workspacePath: string,
): () => void {
  // A rendered tree's workspace is open; the fallback only keeps a tree
  // that outlived its workspace by a frame from throwing.
  const set = expansion.get(workspacePath) ?? new Set<string>();
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
}
