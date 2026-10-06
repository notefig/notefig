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
 * store that could name a closed workspace, and opening IS focusing: there
 * is no way to open a workspace without bringing it to the front.
 *
 * Registry key vs value: `workspaceKey` collapses respellings onto one
 * entry (Windows), while rows and downstream calls carry the normalized
 * native spelling — the same convention as the agent runtime's managers.
 */
import { createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import { defineModule, type WorkspaceLifecycle } from "@notefig/core";
import { path as pathutil, relativeTreePath, workspaceKey } from "@/utils/path";
import { platformModule } from "@/core/services";

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

function createOpenWorkspacesCollection(
  persistence: PersistedCollectionPersistence,
) {
  return createCollection(
    persistedCollectionOptions<OpenWorkspaceRow, string>({
      id: OPEN_WORKSPACES_COLLECTION_ID,
      getKey: (row) => row.key,
      persistence,
    }),
  );
}

/** The open set — `core.workspaceRegistry`. */
export interface WorkspaceRegistry {
  /** Reactive, persisted open set — the switcher's and the boot's source. */
  readonly collection: ReturnType<typeof createOpenWorkspacesCollection>;
  /** Resolves once the open set is hydrated and, if this root restores,
   *  its workspaces are seeded with their listing walks under way.
   *  Idempotent. */
  whenReady(): Promise<void>;
  /**
   * Bring every persisted open workspace back to life after a restart:
   * load the open set, whose rows core opens (`mirror`) — each workspace's
   * modules then start themselves, its files walking the listing and
   * watching. Run once by the module's boot, before render, so nothing
   * observes `whenReady` ahead of it.
   */
  restore(): Promise<void>;
  isOpen(workspacePath: string): boolean;
  /**
   * The open workspace whose tree contains `absolutePath`, or null when no
   * open workspace does. Tree membership, never a string prefix
   * (`/ws-backup` is not inside `/ws`); with nested workspaces open, the
   * deepest wins. This is how a file tab, a write or an editor finds its
   * workspace — the dock is one layout over every open workspace, so
   * nothing may assume an ambient one.
   */
  workspaceOf(absolutePath: string): string | null;
  /**
   * The registry's half of opening or focusing a workspace, run on
   * `workspace:focused` (so through `core.workspace(path).open()` or
   * `.focus()`, never directly). A workspace not yet in the open set joins
   * it once the persisted set has hydrated, which in steady state is
   * immediate. One already in it is brought to the front: the sidebar
   * shows it and new-item actions target it. Resolves once the write is
   * durable: a reload before that would forget the workspace or land on
   * the previous focus. Core has already waited out any close of the same
   * workspace.
   */
  recordFocus(workspacePath: string): Promise<void>;
  /** Drop the row of a workspace core is closing. */
  forget(key: string): void;
  /**
   * Mirror the open set into core's workspace lifecycle, so per-workspace
   * module instances and the `workspace:*` hooks follow the same rows the
   * switcher shows. Rows already present (a restore that ran first) open
   * before the subscription starts; hydrated rows arrive as inserts.
   */
  mirror(lifecycle: WorkspaceLifecycle): () => void;
}

export function createWorkspaceRegistry(
  persistence: PersistedCollectionPersistence,
): WorkspaceRegistry {
  const rows = createOpenWorkspacesCollection(persistence);

  /**
   * The one boot obligation: the persisted open set is hydrated AND every
   * row in it has been brought back to life. Set once by `restore`; a root
   * that never restores (the marketing site seeds its own root) has
   * nothing to wait for beyond the load itself, which is what the fallback
   * returns. One promise, so "ready" cannot mean two things that merely
   * happen to coincide.
   */
  let restored: Promise<void> | null = null;

  /**
   * Every mutation of the open set waits for this. A write issued before
   * the persisted collection has hydrated is assigned a stream position
   * from what the persistence layer has observed so far — before
   * hydration, the very position the previous session already used — and
   * the adapter drops it as already applied: the row shows in memory and
   * is gone on the next launch (workspaces-restore.test.ts pins this). In
   * steady state the wait is a resolved promise.
   */
  const hydrated = () => rows.preload();

  return {
    collection: rows,
    whenReady: () => restored ?? rows.preload(),
    restore() {
      restored ??= rows.preload();
      return restored;
    },
    isOpen: (workspacePath) => rows.has(workspaceKey(workspacePath)),
    workspaceOf: (absolutePath) =>
      workspaceOfPathIn(rows.values(), absolutePath),
    async recordFocus(workspacePath) {
      const key = workspaceKey(workspacePath);
      const native = pathutil.normalize(workspacePath);
      await hydrated();
      if (rows.has(key)) {
        await rows.update(key, (draft) => {
          draft.focusedAt = Date.now();
        }).isPersisted.promise;
        return;
      }
      // The optimistic insert is visible synchronously; only durability
      // waits.
      const now = Date.now();
      await rows.insert({ key, path: native, openedAt: now, focusedAt: now })
        .isPersisted.promise;
    },
    forget(key) {
      if (rows.has(key)) rows.delete(key);
    },
    mirror(lifecycle) {
      for (const row of rows.values()) void lifecycle.open(row.path);
      const subscription = rows.subscribeChanges((changes) => {
        for (const change of changes) {
          if (change.type === "delete") {
            void lifecycle.close(change.value.path);
          } else {
            void lifecycle.open(change.value.path);
          }
        }
      });
      return () => subscription.unsubscribe();
    },
  };
}

// There is deliberately no runtime map here. Membership *is* the
// collection, mirrored into core's workspace lifecycle; every
// per-workspace value is a core workspace module, disposed in need order
// when core closes the workspace. Closing is `core.workspace(path).close()`:
// the row goes on `workspace:closing`, so the switcher drops it at once,
// and agent rows with a live session demote to "restored" (MET-54) as the
// agents module is disposed.

export function mostRecentlyFocused(
  rows: Iterable<OpenWorkspaceRow>,
): OpenWorkspaceRow | null {
  let best: OpenWorkspaceRow | null = null;
  for (const row of rows) {
    if (best === null || row.focusedAt > best.focusedAt) best = row;
  }
  return best;
}

export function workspaceOfPathIn(
  rows: Iterable<Pick<OpenWorkspaceRow, "path">>,
  absolutePath: string,
): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (relativeTreePath(row.path, absolutePath) === undefined) continue;
    if (best === null || row.path.length > best.length) best = row.path;
  }
  return best;
}

declare module "@notefig/core" {
  interface CoreModules {
    workspaceRegistry: WorkspaceRegistry;
  }
}

/**
 * The open set's runtime half: it persists what core opens through a
 * handle, and drops it when core closes it.
 */
export const workspacesModule = defineModule({
  name: "workspaceRegistry",
  needs: [platformModule],
  register: (ctx) => createWorkspaceRegistry(ctx.use("platform").db.get()),
  boot: (registry, ctx) => {
    const stopMirror = registry.mirror(ctx.workspaces);
    const stopFocus = ctx.hooks.on("workspace:focused", (workspace) =>
      registry.recordFocus(workspace.path),
    );
    // Synchronously, first thing in the close: the switcher row goes at
    // once.
    const stopClosing = ctx.hooks.on("workspace:closing", (workspace) =>
      registry.forget(workspace.key),
    );
    return () => {
      stopMirror();
      stopFocus();
      stopClosing();
    };
  },
});

declare module "@notefig/core" {
  interface CoreModules {
    "restore-workspaces": undefined;
  }
}

/**
 * Reopen the workspaces the user left open. The desktop shell runs this;
 * the marketing site always seeds its one fixed root itself.
 */
export const restoreWorkspacesModule = defineModule({
  name: "restore-workspaces",
  needs: [workspacesModule],
  boot: (_api, ctx) => {
    void ctx
      .use("workspaceRegistry")
      .restore()
      .catch((error) => {
        console.error("Failed to restore open workspaces:", error);
      });
  },
});
