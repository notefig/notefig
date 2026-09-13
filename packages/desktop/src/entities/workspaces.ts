/**
 * Workspaces entity — the open set and its runtime lifetime, decoupled from
 * the router (MET-177). A workspace is "open" from first navigation until
 * an explicit close: its file collections stay seeded, its metadata watcher
 * keeps running, and its agent TaskManager keeps its transports —
 * navigating elsewhere backgrounds it instead of tearing it down. Close is
 * explicit only (switcher, error recovery, app teardown); there is
 * deliberately no TTL/LRU eviction, since a background workspace may have
 * agents mid-turn.
 *
 * Registry key vs value: `workspaceKey` collapses respellings onto one
 * entry (Windows), while rows and downstream calls carry the normalized
 * native spelling — the same convention as taskManagerRegistry.
 */
import { useMemo } from "react";
// Split deliberately: the collection itself is host-neutral and comes from
// @tanstack/db, while `useLiveQuery` is the React binding. Keeping them apart
// makes the seam visible — the collection half of this module is what moves
// into @notefig/core, and it must not drag a renderer with it.
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
import {
  clearWorkspaceCollections,
  getOrCreateWorkspaceCollections,
  refreshDirectoryMetadata,
} from "@/entities/files";
import { clearGitCollection } from "@/entities/git";
import { disposeWorkspaceHistoryService } from "@/utils/history-service";
import {
  startWorkspaceMetadataWatcher,
  type WorkspaceMetadataWatcher,
} from "@/utils/file-sync";
import { path as pathutil, workspaceKey } from "@/utils/path";

export interface OpenWorkspaceRow {
  /** workspaceKey(path) — the row id. */
  key: string;
  /** Normalized native spelling, safe for display and navigation. */
  path: string;
  openedAt: number;
}

/** Reactive open set — the workspace switcher's data source. */
export const openWorkspacesCollection = createCollection(
  localOnlyCollectionOptions({
    id: "open-workspaces",
    getKey: (row: OpenWorkspaceRow) => row.key,
  }),
);

/** Per-workspace runtime the registry owns directly (everything else —
 *  task managers, history services, git collections — has its own keyed
 *  registry that open/close delegates to). */
const runtimes = new Map<string, { watcher: WorkspaceMetadataWatcher }>();

/** In-flight closes, keyed like `runtimes`: a reopen racing a close must
 *  wait for the teardown to finish rather than interleave with it. */
const pendingCloses = new Map<string, Promise<void>>();

/**
 * Idempotent: seeds the file collections, kicks the initial listing walk,
 * and starts the workspace-lifetime metadata watcher. Called by Loader on
 * first navigation into the workspace.
 */
export function openWorkspace(workspacePath: string): void {
  const key = workspaceKey(workspacePath);
  const native = pathutil.normalize(workspacePath);
  const pendingClose = pendingCloses.get(key);
  if (pendingClose) {
    // Reopen racing an in-flight close of the same workspace: let the
    // teardown finish, then open fresh — never interleave the two.
    void pendingClose.then(() => openWorkspace(workspacePath));
    return;
  }
  const runtime = runtimes.get(key);
  if (runtime) {
    // Re-entry into a backgrounded workspace: the watcher kept the
    // collection current, but a listing refresh on entry is what the
    // route always did — keep it (cheap re-stat, catches watcher gaps).
    // Also the moment to re-arm a watcher whose start failed (workspace
    // was unreadable when first opened).
    runtime.watcher.ensureStarted();
    void refreshDirectoryMetadata(native);
    return;
  }

  getOrCreateWorkspaceCollections(native);
  void refreshDirectoryMetadata(native);
  runtimes.set(key, { watcher: startWorkspaceMetadataWatcher(native) });
  openWorkspacesCollection.insert({ key, path: native, openedAt: Date.now() });
}

export function isWorkspaceOpen(workspacePath: string): boolean {
  return runtimes.has(workspaceKey(workspacePath));
}

/**
 * Full teardown, the one path shared by the switcher's close, error
 * recovery's repick, and app teardown. Agent rows with a live session
 * demote to "restored" (revivable on next open) per the MET-54 contract —
 * the same semantics the route-unmount teardown had before MET-177 moved
 * ownership here.
 */
export function closeWorkspace(workspacePath: string): Promise<void> {
  const key = workspaceKey(workspacePath);
  const pending = pendingCloses.get(key);
  if (pending) return pending;

  // Synchronous part first: the workspace leaves the open set and stops
  // watching immediately, so the switcher row disappears at once and a
  // reopen during the async teardown is unambiguous (pendingCloses).
  const runtime = runtimes.get(key);
  runtimes.delete(key);
  runtime?.watcher.stop();
  if (openWorkspacesCollection.has(key)) {
    openWorkspacesCollection.delete(key);
  }

  const close = (async () => {
    try {
      await disposeWorkspaceTaskManager(workspacePath);
      disposeWorkspaceHistoryService(workspacePath);
      clearGitCollection(workspacePath);
      clearWorkspaceCollections(workspacePath);
    } finally {
      pendingCloses.delete(key);
    }
  })();
  pendingCloses.set(key, close);
  return close;
}

/**
 * Drops and re-seeds the workspace's file state without touching agents or
 * the watcher — error-boundary recovery after fs access is restored. (A
 * lost fs handle doesn't invalidate running harness processes; they hold
 * their own OS-level access.)
 */
export function reloadWorkspaceFiles(workspacePath: string): void {
  const native = pathutil.normalize(workspacePath);
  clearWorkspaceCollections(native);
  getOrCreateWorkspaceCollections(native);
  void refreshDirectoryMetadata(native);
  // Access was just restored — if the watcher's start failed while the
  // workspace was unreadable, this is the moment it can finally arm.
  runtimes.get(workspaceKey(native))?.watcher.ensureStarted();
}

/** Close every open workspace (close-all affordances and tests; process
 *  exit itself relies on the Rust kill_all_agents backstop, not on this). */
export async function closeAllWorkspaces(): Promise<void> {
  const paths = [...openWorkspacesCollection.values()].map((row) => row.path);
  await Promise.all(paths.map((path) => closeWorkspace(path)));
}

/** The open set as switcher-ready rows, oldest-opened first. */
export function useOpenWorkspaces(): OpenWorkspaceRow[] {
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ workspace: openWorkspacesCollection }),
  );
  return useMemo(
    () => [...rows].sort((a, b) => a.openedAt - b.openedAt),
    [rows],
  );
}
