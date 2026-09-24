/**
 * The open-workspaces collection, as a leaf.
 *
 * `entities/workspaces.ts` owns open/close and imports the per-workspace
 * subsystems it seeds (files, git, history). Those subsystems now scope their
 * own lifetime to this collection (`workspace-scoped.ts`), which would make
 * `files.ts → workspace-scoped.ts → workspaces.ts → files.ts` a cycle. The
 * collection itself depends on nothing but the adapter, so it lives here and
 * `workspaces.ts` re-exports it — the same split as `agent/task-registry.ts`.
 */
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { platformAdapter } from "@/adapters";

export interface OpenWorkspaceRow {
  /** workspaceKey(path) — the row id. */
  key: string;
  /** Normalized native spelling, safe for display and navigation. */
  path: string;
  openedAt: number;
  /** Last time this workspace was brought to the front; the max is the
   *  focused workspace. */
  focusedAt: number;
}

/** The collection id, and so the SQLite table the open set lands in. */
export const OPEN_WORKSPACES_COLLECTION_ID = "open-workspaces";

/** Reactive, persisted open set — the switcher's and the boot's source. */
export const openWorkspacesCollection = createCollection(
  persistedCollectionOptions<OpenWorkspaceRow, string>({
    id: OPEN_WORKSPACES_COLLECTION_ID,
    getKey: (row) => row.key,
    persistence: platformAdapter.db.get(),
  }),
);
