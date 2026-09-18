import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";

// Restart shape: rows are written to the database by a previous "run" (a
// throwaway collection over the same persistence), then the module's own
// collection hydrates them. Own file so the module-scoped collection has
// never been touched before the restore under test.
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

describe("restoreOpenWorkspaces at boot", () => {
  it("reopens every persisted workspace: collections seeded, listings walked, watchers armed, focus kept", async () => {
    const workspaces = await import("./workspaces");
    const { bootstrapAppRuntime } = await import("@/app-runtime");
    expect(workspaces.OPEN_WORKSPACES_COLLECTION_ID).toBe(
      OPEN_WORKSPACES_COLLECTION_ID,
    );

    bootstrapAppRuntime();
    // Ready means restored, not merely loaded: no settle sleep needed for
    // the seeding and walks below to have been issued.
    await workspaces.whenOpenWorkspacesReady();

    const { isWorkspaceOpen, openWorkspacesCollection } = workspaces;
    expect(isWorkspaceOpen("/ws-a")).toBe(true);
    expect(isWorkspaceOpen("/ws-b")).toBe(true);
    expect(
      files.getOrCreateWorkspaceCollections.mock.calls.map(([p]) => p).sort(),
    ).toEqual(["/ws-a", "/ws-b"]);
    expect(
      files.refreshDirectoryMetadata.mock.calls.map(([p]) => p).sort(),
    ).toEqual(["/ws-a", "/ws-b"]);
    expect(watchers.start.mock.calls.map(([p]) => p).sort()).toEqual([
      "/ws-a",
      "/ws-b",
    ]);
    // Focus survives too: the row focused last is the one in front.
    const focused = [...openWorkspacesCollection.values()].sort(
      (a, b) => b.focusedAt - a.focusedAt,
    )[0];
    expect(focused?.path).toBe("/ws-b");
  });
});
