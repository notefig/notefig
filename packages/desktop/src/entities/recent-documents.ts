/**
 * Recent documents — the files the user has had in front of them, across
 * every open workspace, for the sidebar's Everything view.
 *
 * Session-scoped, like the widget store and the per-workspace last tool:
 * an in-memory most-recently-active list, touched whenever a file tab
 * becomes the active one. Deliberately not persisted for now — a KV write
 * issued while a document is open and being typed into was observed to
 * divert the first keystroke and lose the save in the browser adapter, and
 * a recents list is not worth a write on every tab switch until that
 * interaction is understood. Read-side, a row only counts while its
 * workspace is open and the file still exists there: the list is a view
 * over the open set, never a way back into a closed workspace.
 */
import { useMemo, useSyncExternalStore } from "react";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { isScratchpadFileRow } from "@/entities/scratchpads";
import { useOpenWorkspaces, workspaceOfPath } from "@/entities/workspaces";
import { relativeTreePath } from "@/utils/path";

/** Kept in memory; the panel shows fewer. */
const MAX_RECENT_DOCUMENTS = 30;

export interface RecentDocument {
  path: string;
  workspacePath: string;
  lastOpenedAt: number;
  isScratchpad: boolean;
}

/** Insertion-ordered: the last entry is the most recent. */
let recents = new Map<string, number>();
const listeners = new Set<() => void>();

/** Record `path` as the document most recently in front of the user. */
export function touchRecentDocument(path: string): void {
  const next = new Map(recents);
  next.delete(path);
  next.set(path, Date.now());
  while (next.size > MAX_RECENT_DOCUMENTS) {
    next.delete(next.keys().next().value as string);
  }
  recents = next;
  for (const listener of listeners) listener();
}

/** Tests only: forget everything. */
export function resetRecentDocuments(): void {
  recents = new Map();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
  const entries = useSyncExternalStore(subscribe, () => recents);
  // Re-join when the open set changes, not only when the list does.
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(() => {
    const documents: RecentDocument[] = [];
    for (const [path, lastOpenedAt] of [...entries].reverse()) {
      const workspacePath = workspaceOfPath(path);
      if (workspacePath === null) continue;
      if (!existsInWorkspace(workspacePath, path)) continue;
      documents.push({
        path,
        workspacePath,
        lastOpenedAt,
        isScratchpad: isScratchpad(workspacePath, path),
      });
      if (documents.length === limit) break;
    }
    return documents;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, openWorkspaces, limit]);
}
