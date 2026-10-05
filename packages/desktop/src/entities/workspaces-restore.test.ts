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
// Which workspaces core opened the files of: a restored workspace's files
// walk and watch as they are created (their own suite covers that).
const files = vi.hoisted(() => ({ created: [] as string[] }));
// The root's module list boots for real; these entities' per-workspace
// modules stand in as empty instances.
const stubWorkspaceModule = async (
  name: string,
  onCreate?: (path: string) => void,
): Promise<import("@notefig/core").AnyModule> => ({
  name,
  workspace: {
    create: ({ workspace }: { workspace: { path: string } }) => {
      onCreate?.(workspace.path);
      return {};
    },
  },
});
vi.mock("@/entities/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/entities/files")>()),
  filesModule: await stubWorkspaceModule("files", (path) =>
    files.created.push(path),
  ),
}));
vi.mock("@/entities/git", async () => ({
  clearGitCollection: vi.fn(),
  gitModule: await stubWorkspaceModule("git"),
}));
vi.mock("@/utils/history-service", async () => ({
  historyModule: await stubWorkspaceModule("history"),
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
  it("reopens every persisted workspace: core opens its modules, focus kept", async () => {
    const workspaces = await import("./workspaces");
    const { createAppCore, runtimeModules } = await import("@/core/app-core");
    const { memoryUrlState } = await import("@/testing/test-core");
    expect(workspaces.OPEN_WORKSPACES_COLLECTION_ID).toBe(
      OPEN_WORKSPACES_COLLECTION_ID,
    );

    createAppCore(runtimeModules({ restoreWorkspaces: true }), {
      url: memoryUrlState(),
    }).boot();
    await workspaces.whenOpenWorkspacesReady();

    const { isWorkspaceOpen, openWorkspacesCollection } = workspaces;
    expect(isWorkspaceOpen("/ws-a")).toBe(true);
    expect(isWorkspaceOpen("/ws-b")).toBe(true);
    await vi.waitFor(() =>
      expect([...files.created].sort()).toEqual(["/ws-a", "/ws-b"]),
    );
    // Focus survives too: the row focused last is the one in front.
    const focused = [...openWorkspacesCollection.values()].sort(
      (a, b) => b.focusedAt - a.focusedAt,
    )[0];
    expect(focused?.path).toBe("/ws-b");
  });
});
