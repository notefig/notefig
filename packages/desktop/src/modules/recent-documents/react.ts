/**
 * Recent documents from React.
 */
import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useCore } from "@notefig/core/react";
import { useOpenWorkspaces } from "@/modules/workspaces/react";
import { deriveRecentDocuments, type RecentDocument } from "./recent-documents";

/**
 * The most recent documents across the open workspaces, newest first,
 * capped at `limit`. Re-resolves as workspaces open and close.
 */
export function useRecentDocuments(limit: number): RecentDocument[] {
  const core = useCore();
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ recent: core.recentDocuments.collection }),
  );
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(() => {
    // Does the file still exist in the workspace's listing? Non-reactive:
    // the list re-renders on its own inputs, and a deleted file's tab
    // prunes itself long before this matters.
    const existsInWorkspace = (workspacePath: string, path: string) =>
      core.workspaces.isOpen(workspacePath) &&
      core.workspace(workspacePath).files.collections.metadata.has(path);
    return deriveRecentDocuments(
      rows,
      openWorkspaces,
      existsInWorkspace,
      limit,
    );
  }, [core, rows, openWorkspaces, limit]);
}
