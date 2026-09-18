import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";

// Same restart rig as workspaces-restore.test.ts, in its own file so the
// module-scoped collection is fresh: an already-hydrated module collection
// would be stale against rows a later setup wrote, which is the very
// collision under test — but from the rig, not the app.
const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as null | import("@/testing/node-db").NodeTestDb },
}));
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (dbRef.current = (
      await import("@/testing/node-db")
    ).createNodeTestDb()),
    fs: {
      writeFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
      readFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
    },
    proc: {
      createMcpEndpoint: vi.fn(),
      createAgentTransport: vi.fn(),
    },
  },
}));
const files = vi.hoisted(() => ({
  getOrCreateWorkspaceCollections: vi.fn((_path: string) => undefined),
  refreshDirectoryMetadata: vi.fn(async (_path: string) => {}),
  clearWorkspaceCollections: vi.fn(),
}));
vi.mock("@/entities/files", () => files);
vi.mock("@/entities/git", () => ({ clearGitCollection: vi.fn() }));
vi.mock("@/utils/history-service", () => ({
  disposeWorkspaceHistoryService: vi.fn(),
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));
const watchers = vi.hoisted(() => ({
  start: vi.fn<
    (path: string) => { stop: () => void; ensureStarted: () => void }
  >(() => ({ stop: vi.fn(), ensureStarted: vi.fn() })),
}));
vi.mock("@/utils/file-sync", () => ({
  startWorkspaceMetadataWatcher: watchers.start,
}));

import type { OpenWorkspaceRow } from "./workspaces";

// The persisted collection loads the moment its module is evaluated (that
// IS the boot read), so the module under test is imported only after the
// previous run's rows are on disk.
const OPEN_WORKSPACES_COLLECTION_ID = "open-workspaces";

beforeEach(async () => {
  // Instantiate the mocked adapter (its factory runs on first import).
  await import("@/adapters");
  // "Previous run": persist two open workspaces, /ws-b focused last.
  const previousRun = createCollection(
    persistedCollectionOptions<OpenWorkspaceRow, string>({
      id: OPEN_WORKSPACES_COLLECTION_ID,
      getKey: (row) => row.key,
      persistence: dbRef.current!.get(),
    }),
  );
  await previousRun.preload();
  await previousRun.insert({
    key: "/ws-a",
    path: "/ws-a",
    openedAt: 1,
    focusedAt: 1,
  }).isPersisted.promise;
  await previousRun.insert({
    key: "/ws-b",
    path: "/ws-b",
    openedAt: 2,
    focusedAt: 5,
  }).isPersisted.promise;
  await previousRun.cleanup();
});

describe("writes issued before the persisted set has hydrated", () => {
  it("an open issued before hydration is durable: the row survives a restart", async () => {
    const workspaces = await import("./workspaces");
    // No await of readiness: the caller writes the moment the module is up,
    // as the test seam and a native "Open Folder" during boot can.
    await workspaces.openWorkspace("/ws-c");

    // "Next run": a fresh collection over the same storage sees only what
    // was really committed.
    const nextRun = createCollection(
      persistedCollectionOptions<OpenWorkspaceRow, string>({
        id: OPEN_WORKSPACES_COLLECTION_ID,
        getKey: (row) => row.key,
        persistence: dbRef.current!.get(),
      }),
    );
    await nextRun.preload();
    expect([...nextRun.values()].map((row) => row.path).sort()).toEqual([
      "/ws-a",
      "/ws-b",
      "/ws-c",
    ]);
    await nextRun.cleanup();
  });
});

