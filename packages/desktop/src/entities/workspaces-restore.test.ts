import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { QueryClient } from "@tanstack/react-query";
import { createCore, type AnyModule } from "@notefig/core";
import {
  OPEN_WORKSPACES_COLLECTION_ID,
  type OpenWorkspaceRow,
} from "./workspaces";
import { runtimeModules } from "@/core/app-core";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import { memoryUrlState } from "@/testing/test-core";
import { workspaceKey } from "@/utils/path";

// Restart shape: rows are written to the database by a previous "run" (a
// throwaway collection over the same persistence), then the registry's own
// collection hydrates them. The previous run's rows are on disk before the
// core under test exists, so its collection has never been touched before
// the restore under test.
let db: NodeTestDb;

// Which workspaces core opened the files of: a restored workspace's files
// walk and watch as they are created (their own suite covers that).
let filesCreated: string[];

// The root's module list boots for real; these entities' per-workspace
// modules stand in as empty instances.
const stubWorkspaceModule = (
  name: string,
  onCreate?: (path: string) => void,
): AnyModule => ({
  name,
  workspace: {
    create: ({ workspace }: { workspace: { path: string } }) => {
      onCreate?.(workspace.path);
      return {};
    },
  },
});

beforeEach(async () => {
  db = createNodeTestDb();
  filesCreated = [];
  // "Previous run": persist two open workspaces, /ws-b focused last.
  const previousRun = createCollection(
    persistedCollectionOptions<OpenWorkspaceRow, string>({
      id: OPEN_WORKSPACES_COLLECTION_ID,
      getKey: (row) => row.key,
      persistence: db.get(),
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

describe("restoring the open workspaces at boot", () => {
  it("reopens every persisted workspace: core opens its modules, focus kept", async () => {
    const stubs: Record<string, AnyModule> = {
      files: stubWorkspaceModule("files", (path) => filesCreated.push(path)),
      git: stubWorkspaceModule("git"),
      history: stubWorkspaceModule("history"),
    };
    // Built as `createAppCore` builds it, over this test's platform.
    const core = createCore({
      services: {
        platform: {
          db,
          fs: {
            writeFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
            readFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
          },
          proc: {
            createMcpEndpoint: vi.fn(),
            createAgentTransport: vi.fn(),
          },
        },
        queryClient: new QueryClient(),
        url: memoryUrlState(),
      } as never,
      modules: runtimeModules({ restoreWorkspaces: true }).map(
        (module) => stubs[module.name] ?? module,
      ),
      workspaceKey,
    });
    core.boot();
    const registry = core.use("workspaceRegistry");
    await registry.whenReady();

    expect(registry.isOpen("/ws-a")).toBe(true);
    expect(registry.isOpen("/ws-b")).toBe(true);
    await vi.waitFor(() =>
      expect([...filesCreated].sort()).toEqual(["/ws-a", "/ws-b"]),
    );
    // Focus survives too: the row focused last is the one in front.
    const focused = [...registry.collection.values()].sort(
      (a, b) => b.focusedAt - a.focusedAt,
    )[0];
    expect(focused?.path).toBe("/ws-b");
  });
});
