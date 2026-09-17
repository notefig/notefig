/**
 * Workspaces entity — the open set and its runtime lifetime, decoupled from
 * the router (MET-177). A workspace is "open" from first open until an
 * explicit close: its file collections stay seeded, its metadata watcher
 * keeps running, and its agent TaskManager keeps its transports —
 * looking elsewhere backgrounds it instead of tearing it down. Close is
 * explicit only (switcher, error recovery, app teardown); there is
 * deliberately no TTL/LRU eviction, since a background workspace may have
 * agents mid-turn.
 *
 * The open set is persisted (SQLite, like the agent tasks): the app is a
 * command center over every workspace the user left open, so a restart
 * restores them all — collections seeded, watchers armed — before any
 * layout is trusted (`restoreOpenWorkspaces`, run by the boot sequence).
 * One of them is "focused": the workspace the sidebar shows and new-item
 * actions target. Focus is a row attribute (`focusedAt`), never a second
 * store that could name a closed workspace.
 *
 * Registry key vs value: `workspaceKey` collapses respellings onto one
 * entry (Windows), while rows and downstream calls carry the normalized
 * native spelling — the same convention as taskManagerRegistry.
 */
import { useEffect, useMemo, useState } from "react";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { platformAdapter } from "@/adapters";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
import {
  clearWorkspaceCollections,
  getOrCreateWorkspaceCollections,
  refreshDirectoryMetadata,
} from "@/entities/files";
import { clearGitCollection } from "@/entities/git";
import { disposeWorkspaceHistoryService } from "@/utils/history-service";
import { path as pathutil, relativeTreePath, workspaceKey } from "@/utils/path";

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

/** Resolves once the persisted open set has loaded. Idempotent. */
export function whenOpenWorkspacesLoaded(): Promise<void> {
  return openWorkspacesCollection.preload();
}

/**
 * Bring every persisted open workspace back to life after a restart: seed
 * its collections and kick the listing walk, exactly as `openWorkspace`
 * does for a fresh open — minus the insert, since the row is what told us
 * to. Watchers arm through the registry subscription, which reconciles the
 * rows it finds. Called once by the boot sequence (app-runtime.ts).
 */
export async function restoreOpenWorkspaces(): Promise<void> {
  await whenOpenWorkspacesLoaded();
  for (const row of openWorkspacesCollection.values()) {
    getOrCreateWorkspaceCollections(row.path);
    void refreshDirectoryMetadata(row.path);
  }
}

/**
 * True once the persisted open set has loaded — gates anything that would
 * treat "not in the open set" as meaningful (stale-tab pruning) so a
 * restored layout is never emptied while its workspaces are still loading.
 */
export function useOpenWorkspacesReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void whenOpenWorkspacesLoaded().finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

// There is deliberately no runtime map here any more. It used to hold one
// thing — the metadata watcher — and once watching moved to the portal
// (subscription below), membership *is* the collection. Everything else the
// registry tears down (task managers, history services, git collections)
// has its own keyed registry that open/close delegates to.

/** In-flight closes, keyed like the collection: a reopen racing a close must
 *  wait for the teardown to finish rather than interleave with it. */
const pendingCloses = new Map<string, Promise<void>>();

/**
 * Idempotent: seeds the file collections, kicks the initial listing walk,
 * and adds the workspace to the open set — synchronously, so it is open
 * (and watched, via the registry subscription) by the time this returns.
 * The promise resolves once the membership is durable: a reload before
 * that would forget the workspace, so callers that can be followed by one
 * (the test seam) await it.
 */
export function openWorkspace(workspacePath: string): Promise<void> {
  const key = workspaceKey(workspacePath);
  const native = pathutil.normalize(workspacePath);
  const pendingClose = pendingCloses.get(key);
  if (pendingClose) {
    // Reopen racing an in-flight close of the same workspace: let the
    // teardown finish, then open fresh — never interleave the two.
    return pendingClose.then(() => openWorkspace(workspacePath));
  }
  const existing = openWorkspacesCollection.get(key);
  if (existing) {
    // Re-entry into a backgrounded workspace: the watcher kept the
    // collection current, but a listing refresh on entry is what the
    // route always did — keep it (cheap re-stat, catches watcher gaps).
    // Re-arming a watcher that failed to start is the portal's other half
    // of re-entry (`showWorkspace` in hooks/use-open-project.ts).
    void refreshDirectoryMetadata(native);
    return Promise.resolve();
  }

  getOrCreateWorkspaceCollections(native);
  void refreshDirectoryMetadata(native);
  const now = Date.now();
  return openWorkspacesCollection
    .insert({ key, path: native, openedAt: now, focusedAt: now })
    .isPersisted.promise.then(() => undefined);
}

/**
 * Bring an open workspace to the front: the sidebar shows it and new-item
 * actions target it. Also the moment to re-stat its listing, as re-entry
 * always did (cheap, catches watcher gaps). No-op for a workspace that is
 * not open — opening is a separate, explicit act.
 */
export function focusWorkspace(workspacePath: string): Promise<void> {
  const key = workspaceKey(workspacePath);
  const row = openWorkspacesCollection.get(key);
  if (!row) return Promise.resolve();
  void refreshDirectoryMetadata(row.path);
  return openWorkspacesCollection
    .update(key, (draft) => {
      draft.focusedAt = Date.now();
    })
    .isPersisted.promise.then(() => undefined);
}

function mostRecentlyFocused(
  rows: Iterable<OpenWorkspaceRow>,
): OpenWorkspaceRow | null {
  let best: OpenWorkspaceRow | null = null;
  for (const row of rows) {
    if (best === null || row.focusedAt > best.focusedAt) best = row;
  }
  return best;
}

export function useFocusedWorkspace(): string | null {
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ workspace: openWorkspacesCollection }),
  );
  return useMemo(() => mostRecentlyFocused(rows)?.path ?? null, [rows]);
}

export function isWorkspaceOpen(workspacePath: string): boolean {
  return openWorkspacesCollection.has(workspaceKey(workspacePath));
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

  // Synchronous part first: the workspace leaves the open set at once, so
  // the switcher row disappears immediately and a reopen during the async
  // teardown is unambiguous (pendingCloses). Dropping the row is also what
  // stops the metadata watcher — the portal's subscription sees the delete.
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
  // workspace was unreadable, this is the moment it can finally arm. The
  // error boundary calls `ensureWatching` alongside this, for the same
  // reason the loader does: watching is the portal's business.
}

/** Close every open workspace (close-all affordances and tests; process
 *  exit itself relies on the Rust kill_all_agents backstop, not on this). */
export async function closeAllWorkspaces(): Promise<void> {
  const paths = [...openWorkspacesCollection.values()].map((row) => row.path);
  await Promise.all(paths.map((path) => closeWorkspace(path)));
}

/**
 * The open workspace whose tree contains `absolutePath`, or null when no
 * open workspace does. Tree membership, never a string prefix (`/ws-backup`
 * is not inside `/ws`); with nested workspaces open, the deepest wins. This
 * is how a file tab, a write or an editor finds its workspace — the dock is
 * one layout over every open workspace, so nothing may assume an ambient
 * one.
 */
export function workspaceOfPath(absolutePath: string): string | null {
  return workspaceOfPathIn(openWorkspacesCollection.values(), absolutePath);
}

function workspaceOfPathIn(
  rows: Iterable<OpenWorkspaceRow>,
  absolutePath: string,
): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (relativeTreePath(row.path, absolutePath) === undefined) continue;
    if (best === null || row.path.length > best.length) best = row.path;
  }
  return best;
}

/** Reactive `workspaceOfPath`: re-resolves as workspaces open and close. */
export function useWorkspaceOfPath(absolutePath: string): string | null {
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ workspace: openWorkspacesCollection }),
  );
  return useMemo(
    () => workspaceOfPathIn(rows, absolutePath),
    [rows, absolutePath],
  );
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
