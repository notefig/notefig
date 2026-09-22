/**
 * Recent documents — the files the user has had in front of them, across
 * every open workspace, for the sidebar's Everything view.
 *
 * Persisted (a local-only collection over the `db` surface, like the open
 * workspaces): a row per path, touched whenever a file tab becomes the
 * active one, so the list survives a relaunch. Writes wait for hydration
 * (see kv-store's `upsert` for why a pre-hydration write is silently lost)
 * and happen on tab activation only — never on a keystroke — which keeps
 * them clear of the editor's typing path. Read-side, a row only counts
 * while its workspace is open and the file still exists there: rows of a
 * closed workspace stay stored and come back when it is reopened; the list
 * is a view over the open set, never a way back into a closed workspace.
 */
import { useMemo } from "react";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { platformAdapter } from "@/adapters";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { isScratchpadFileRow } from "@/entities/scratchpads";
import {
  useOpenWorkspaces,
  workspaceOfPath,
  type OpenWorkspaceRow,
} from "@/entities/workspaces";
import { relativeTreePath, workspaceKey } from "@/utils/path";

export const RECENT_DOCUMENTS_COLLECTION_ID = "recent-documents";
/** Rows kept in storage across every workspace; the panel shows fewer. */
export const MAX_RECENT_DOCUMENTS = 100;

export interface RecentDocumentRow {
  /** Absolute path — the row id. */
  path: string;
  /** workspaceKey(workspace) at touch time, for the open-set join. */
  workspaceKey: string;
  lastOpenedAt: number;
}

export interface RecentDocument {
  path: string;
  workspacePath: string;
  lastOpenedAt: number;
  isScratchpad: boolean;
}

export const recentDocumentsCollection = createCollection(
  persistedCollectionOptions<RecentDocumentRow, string>({
    id: RECENT_DOCUMENTS_COLLECTION_ID,
    getKey: (row) => row.path,
    persistence: platformAdapter.db.get(),
  }),
);

/**
 * Record `path` as the document most recently in front of the user. A path
 * outside every open workspace is not a document of ours and is ignored.
 * Resolves once the row is durable.
 */
export async function touchRecentDocument(
  path: string,
  now: number = Date.now(),
): Promise<void> {
  const workspacePath = workspaceOfPath(path);
  if (workspacePath === null) return;
  await recentDocumentsCollection.preload();
  const row: RecentDocumentRow = {
    path,
    workspaceKey: workspaceKey(workspacePath),
    lastOpenedAt: now,
  };
  const tx = recentDocumentsCollection.get(path)
    ? recentDocumentsCollection.update(path, (draft) => {
        draft.lastOpenedAt = now;
        draft.workspaceKey = row.workspaceKey;
      })
    : recentDocumentsCollection.insert(row);
  await tx.isPersisted.promise;
  await pruneRecentDocuments();
}

/** Keep storage bounded: drop the oldest rows past the cap. */
async function pruneRecentDocuments(): Promise<void> {
  const rows = [...recentDocumentsCollection.values()].sort(
    (a, b) => a.lastOpenedAt - b.lastOpenedAt,
  );
  const excess = rows.length - MAX_RECENT_DOCUMENTS;
  if (excess <= 0) return;
  await recentDocumentsCollection.delete(
    rows.slice(0, excess).map((row) => row.path),
  ).isPersisted.promise;
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
 * The stored rows joined to the open set, newest first, capped at `limit`
 * — pure, so the ordering and the "open workspace, existing file" rule are
 * testable without React. `exists` is the file-listing check.
 */
export function deriveRecentDocuments(
  rows: RecentDocumentRow[],
  openWorkspaces: Pick<OpenWorkspaceRow, "key" | "path">[],
  exists: (workspacePath: string, path: string) => boolean,
  limit: number,
): RecentDocument[] {
  const pathByKey = new Map(openWorkspaces.map((row) => [row.key, row.path]));
  const documents: RecentDocument[] = [];
  for (const row of [...rows].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
    const workspacePath = pathByKey.get(row.workspaceKey);
    if (workspacePath === undefined) continue;
    if (!exists(workspacePath, row.path)) continue;
    documents.push({
      path: row.path,
      workspacePath,
      lastOpenedAt: row.lastOpenedAt,
      isScratchpad: isScratchpad(workspacePath, row.path),
    });
    if (documents.length === limit) break;
  }
  return documents;
}

/**
 * The most recent documents across the open workspaces, newest first,
 * capped at `limit`. Re-resolves as workspaces open and close.
 */
export function useRecentDocuments(limit: number): RecentDocument[] {
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ recent: recentDocumentsCollection }),
  );
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(
    () => deriveRecentDocuments(rows, openWorkspaces, existsInWorkspace, limit),
    [rows, openWorkspaces, limit],
  );
}
