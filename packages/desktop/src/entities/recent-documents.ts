/**
 * Recent documents — the files the user has had in front of them, across
 * every open workspace, for the sidebar's Everything view.
 *
 * A KV namespace like recent projects (path → last-active time), touched
 * whenever a file tab becomes the active one. Read-side, a row only counts
 * while its workspace is open and the file still exists there: the list is
 * a view over the open set, never a way back into a closed workspace.
 */
import { useMemo } from "react";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { isScratchpadFileRow } from "@/entities/scratchpads";
import { useOpenWorkspaces, workspaceOfPath } from "@/entities/workspaces";
import { readAllKv, removeKv, useKv, writeKv } from "@/utils/kv-store";
import { relativeTreePath } from "@/utils/path";

const RECENT_DOCUMENTS_NAMESPACE = "recentDocuments";
/** Kept on disk; the panel shows fewer. */
const MAX_RECENT_DOCUMENTS = 30;

interface RecentDocumentValue {
  lastOpenedAt: number;
}

export interface RecentDocument {
  path: string;
  workspacePath: string;
  lastOpenedAt: number;
  isScratchpad: boolean;
}

/** Record `path` as the document most recently in front of the user. */
export function touchRecentDocument(path: string): void {
  void writeKv<RecentDocumentValue>(RECENT_DOCUMENTS_NAMESPACE, path, {
    lastOpenedAt: Date.now(),
  }).then(pruneRecentDocuments);
}

/** Drop the oldest rows past the cap — bounded storage, like recent projects. */
async function pruneRecentDocuments(): Promise<void> {
  const all = await readAllKv<RecentDocumentValue>(RECENT_DOCUMENTS_NAMESPACE);
  const entries = Object.entries(all);
  if (entries.length <= MAX_RECENT_DOCUMENTS) return;
  const stale = entries
    .sort((a, b) => a[1].lastOpenedAt - b[1].lastOpenedAt)
    .slice(0, entries.length - MAX_RECENT_DOCUMENTS);
  await Promise.all(
    stale.map(([path]) => removeKv(RECENT_DOCUMENTS_NAMESPACE, path)),
  );
}

/** Does the file still exist in the workspace's listing? Non-reactive:
 *  the list re-renders on its own inputs, and a deleted file's tab prunes
 *  itself long before this matters. */
function existsInWorkspace(workspacePath: string, path: string): boolean {
  return getOrCreateWorkspaceCollections(workspacePath).metadata.has(path);
}

function isScratchpad(workspacePath: string, path: string): boolean {
  const relativePath = relativeTreePath(workspacePath, path);
  return isScratchpadFileRow({ relativePath, type: "file" });
}

/**
 * The most recent documents across the open workspaces, newest first,
 * capped at `limit`. Re-resolves as workspaces open and close.
 */
export function useRecentDocuments(limit: number): RecentDocument[] {
  const { values } = useKv<RecentDocumentValue>(RECENT_DOCUMENTS_NAMESPACE);
  // Re-join when the open set changes, not only when the KV rows do.
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(() => {
    const documents: RecentDocument[] = [];
    for (const [path, value] of Object.entries(values)) {
      const workspacePath = workspaceOfPath(path);
      if (workspacePath === null) continue;
      if (!existsInWorkspace(workspacePath, path)) continue;
      documents.push({
        path,
        workspacePath,
        lastOpenedAt: value.lastOpenedAt,
        isScratchpad: isScratchpad(workspacePath, path),
      });
    }
    return documents
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, openWorkspaces, limit]);
}
