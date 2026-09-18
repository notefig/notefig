/**
 * Watcher lifetime after the MET-183 inversion.
 *
 * These assertions used to live in entities/workspaces.test.ts, where the
 * registry started watchers directly. The registry no longer knows watchers
 * exist — it publishes membership, nothing more — so the coverage moves
 * here, to the module that now owns them. The two behaviors MET-177
 * established are the ones most at risk from the inversion and are asserted
 * explicitly below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const watchers = vi.hoisted(() => ({
  started: [] as string[],
  stops: [] as Array<ReturnType<typeof vi.fn>>,
  ensures: [] as Array<ReturnType<typeof vi.fn>>,
  start: vi.fn((path: string) => {
    const stop = vi.fn();
    const ensureStarted = vi.fn();
    watchers.started.push(path);
    watchers.stops.push(stop);
    watchers.ensures.push(ensureStarted);
    return { stop, ensureStarted };
  }),
}));
vi.mock("@/utils/file-sync", () => ({
  startWorkspaceMetadataWatcher: watchers.start,
}));
// The open set is a persisted collection; give it the in-memory SQLite rig
// rather than the browser adapter's coordinator, which has no page to lead.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

import {
  openWorkspacesCollection,
  type OpenWorkspaceRow,
} from "@/entities/workspaces";
import {
  ensureWatching,
  startWorkspaceWatcherSubscription,
} from "../workspace-watchers";

function row(key: string): OpenWorkspaceRow {
  return { key, path: key, openedAt: 1, focusedAt: 1 };
}

let stopSubscription: (() => void) | undefined;

beforeEach(() => {
  for (const existing of [...openWorkspacesCollection.values()]) {
    openWorkspacesCollection.delete(existing.key);
  }
  watchers.started.length = 0;
  watchers.stops.length = 0;
  watchers.ensures.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  stopSubscription?.();
  stopSubscription = undefined;
});

describe("startWorkspaceWatcherSubscription", () => {
  it("arms a watcher when a workspace joins the open set", () => {
    stopSubscription = startWorkspaceWatcherSubscription();

    openWorkspacesCollection.insert(row("/ws"));

    expect(watchers.started).toEqual(["/ws"]);
  });

  it("adopts workspaces that were already open before it started", () => {
    // Boot order is the host's choice, and a restored session opens
    // workspaces before the portal is ready.
    openWorkspacesCollection.insert(row("/ws-a"));
    openWorkspacesCollection.insert(row("/ws-b"));

    stopSubscription = startWorkspaceWatcherSubscription();

    expect(watchers.started.sort()).toEqual(["/ws-a", "/ws-b"]);
  });

  it("stops the watcher when the workspace leaves the open set", () => {
    stopSubscription = startWorkspaceWatcherSubscription();
    openWorkspacesCollection.insert(row("/ws"));

    openWorkspacesCollection.delete("/ws");

    expect(watchers.stops[0]).toHaveBeenCalledTimes(1);
  });

  it("keeps watching a workspace that is open but not rendered (MET-177)", () => {
    // The whole point of splitting metadata watchers from content watchers:
    // membership is the trigger, never what is currently on screen. There is
    // nothing to render in this test and the watcher still runs.
    stopSubscription = startWorkspaceWatcherSubscription();
    openWorkspacesCollection.insert(row("/ws"));

    expect(watchers.started).toEqual(["/ws"]);
    expect(watchers.stops[0]).not.toHaveBeenCalled();
  });

  it("re-arms through ensureWatching — the failed-start retry (MET-177)", () => {
    stopSubscription = startWorkspaceWatcherSubscription();
    openWorkspacesCollection.insert(row("/ws"));

    ensureWatching("/ws");

    expect(watchers.ensures[0]).toHaveBeenCalledTimes(1);
    // Re-arming must not stack a second watcher on the same workspace.
    expect(watchers.started).toEqual(["/ws"]);
  });

  it("ensureWatching is a no-op for a workspace that is not open", () => {
    stopSubscription = startWorkspaceWatcherSubscription();

    expect(() => ensureWatching("/never-opened")).not.toThrow();
    expect(watchers.started).toEqual([]);
  });

  it("does not double-arm when the row is updated in place", () => {
    stopSubscription = startWorkspaceWatcherSubscription();
    openWorkspacesCollection.insert(row("/ws"));
    openWorkspacesCollection.update("/ws", (draft) => {
      draft.openedAt = 2;
    });

    expect(watchers.started).toEqual(["/ws"]);
  });

  it("is idempotent: a second start while one is live is a no-op", () => {
    // `watchers` is module scope, so a second real subscription would share
    // it — the second disposer would stop the first's watchers and leave the
    // first subscribed to an empty map. The doc comment asserted this
    // property before anything enforced it.
    stopSubscription = startWorkspaceWatcherSubscription();
    const second = startWorkspaceWatcherSubscription();

    openWorkspacesCollection.insert(row("/ws"));

    expect(second).toBe(stopSubscription);
    expect(watchers.started).toEqual(["/ws"]);
  });

  it("stops every watcher it armed when the subscription is torn down", () => {
    const stop = startWorkspaceWatcherSubscription();
    openWorkspacesCollection.insert(row("/ws-a"));
    openWorkspacesCollection.insert(row("/ws-b"));

    stop();

    expect(watchers.stops).toHaveLength(2);
    for (const stopWatcher of watchers.stops) {
      expect(stopWatcher).toHaveBeenCalledTimes(1);
    }
  });
});
