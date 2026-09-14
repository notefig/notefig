import { describe, it, expect, vi, beforeEach } from "vitest";

// Same rig as agent-persistence.test.ts: the tasks collection persists into
// a real in-memory SQLite via the desktop driver, so closeWorkspace's
// demote-to-restored runs the production path end to end.
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
      deleteFiles: vi.fn(async (paths: string[]) => ({
        succeeded: paths,
        failed: [],
      })),
    },
    proc: {
      createMcpEndpoint: vi.fn(() => ({
        mcpServer: undefined,
        start: vi.fn(async () => {}),
        onRequest: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
      createAgentTransport: vi.fn(),
    },
  },
}));

// The registry orchestrates these per-workspace subsystems; the test pins
// the orchestration (what gets called when), not their internals.
const files = vi.hoisted(() => ({
  getOrCreateWorkspaceCollections: vi.fn(),
  refreshDirectoryMetadata: vi.fn(async () => {}),
  clearWorkspaceCollections: vi.fn(),
}));
vi.mock("@/entities/files", () => files);
const git = vi.hoisted(() => ({ clearGitCollection: vi.fn() }));
vi.mock("@/entities/git", () => git);
const history = vi.hoisted(() => ({
  disposeWorkspaceHistoryService: vi.fn(),
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/utils/history-service", () => history);
// No file-sync mock: watcher lifetime left the registry in MET-183. The
// registry publishes membership and nothing else; arming, stopping and
// re-arming are covered by utils/__tests__/workspace-watchers.test.ts.

import {
  openWorkspace,
  closeWorkspace,
  closeAllWorkspaces,
  isWorkspaceOpen,
  openWorkspacesCollection,
} from "./workspaces";
import {
  agentTasksCollection,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import { unregisterTask } from "@/agent/task-registry";

function taskRow(overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  return {
    taskId: "task_a",
    workspacePath: "/ws",
    title: "Rewrite chapter 3",
    status: "idle",
    harnessId: "claude-code",
    sessionId: "sess_1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

beforeEach(async () => {
  dbRef.current!.repairWrites();
  vi.clearAllMocks();
  for (const row of [...openWorkspacesCollection.values()]) {
    await closeWorkspace(row.path);
  }
  vi.clearAllMocks();
  for (const t of agentTasksCollection.toArray) {
    unregisterTask(t.taskId);
    await agentTasksCollection.delete(t.taskId).isPersisted.promise;
  }
  await agentTasksCollection.preload();
});

describe("openWorkspace", () => {
  it("seeds collections, refreshes, inserts the row", () => {
    openWorkspace("/ws");

    expect(files.getOrCreateWorkspaceCollections).toHaveBeenCalledWith("/ws");
    expect(files.refreshDirectoryMetadata).toHaveBeenCalledWith("/ws");
    expect(isWorkspaceOpen("/ws")).toBe(true);
    expect([...openWorkspacesCollection.values()]).toMatchObject([
      { path: "/ws" },
    ]);
  });

  it("is idempotent: re-entry refreshes the listing but never re-seeds", () => {
    openWorkspace("/ws");
    openWorkspace("/ws");
    // Same workspace under a respelled path collapses onto one entry.
    openWorkspace("/ws/");

    expect(files.getOrCreateWorkspaceCollections).toHaveBeenCalledTimes(1);
    expect(files.refreshDirectoryMetadata).toHaveBeenCalledTimes(3);
    expect(openWorkspacesCollection.size).toBe(1);
  });

  it("keeps independent entries per workspace", () => {
    openWorkspace("/ws-a");
    openWorkspace("/ws-b");

    expect(openWorkspacesCollection.size).toBe(2);
    expect(isWorkspaceOpen("/ws-a")).toBe(true);
    expect(isWorkspaceOpen("/ws-b")).toBe(true);
  });
});

describe("closeWorkspace", () => {
  it("tears down every per-workspace subsystem and drops the row", async () => {
    openWorkspace("/ws");

    await closeWorkspace("/ws");

    expect(history.disposeWorkspaceHistoryService).toHaveBeenCalledWith("/ws");
    expect(git.clearGitCollection).toHaveBeenCalledWith("/ws");
    expect(files.clearWorkspaceCollections).toHaveBeenCalledWith("/ws");
    expect(isWorkspaceOpen("/ws")).toBe(false);
    expect(openWorkspacesCollection.size).toBe(0);
  });

  it("demotes sessionful task rows to restored and purges sessionless ones (MET-54 contract)", async () => {
    openWorkspace("/ws");
    await agentTasksCollection.insert(taskRow({ status: "running" }))
      .isPersisted.promise;
    await agentTasksCollection.insert(
      taskRow({ taskId: "task_b", sessionId: undefined, status: "error" }),
    ).isPersisted.promise;
    // A neighbouring workspace's row must be untouched by the close.
    await agentTasksCollection.insert(
      taskRow({ taskId: "task_other", workspacePath: "/other" }),
    ).isPersisted.promise;

    await closeWorkspace("/ws");

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    expect(agentTasksCollection.get("task_b")).toBeUndefined();
    expect(agentTasksCollection.get("task_other")).toMatchObject({
      status: "idle",
    });
  });

  it("is a no-op for a workspace that is not open", async () => {
    await closeWorkspace("/never-opened");
    expect(files.clearWorkspaceCollections).toHaveBeenCalledWith(
      "/never-opened",
    );
    expect(openWorkspacesCollection.size).toBe(0);
  });
});

describe("close/reopen race", () => {
  it("a reopen during an in-flight close waits for the teardown, then opens fresh", async () => {
    openWorkspace("/ws");
    await agentTasksCollection.insert(taskRow({ status: "running" }))
      .isPersisted.promise;

    const closing = closeWorkspace("/ws");
    // Synchronous effects of close land immediately…
    expect(isWorkspaceOpen("/ws")).toBe(false);
    expect(openWorkspacesCollection.size).toBe(0);

    // …and a reopen issued mid-teardown neither throws nor interleaves.
    openWorkspace("/ws");
    await closing;
    await Promise.resolve();

    expect(isWorkspaceOpen("/ws")).toBe(true);
    expect(openWorkspacesCollection.size).toBe(1);
    // The close's teardown ran (row demoted), and the reopen re-seeded
    // collections after it — not before.
    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    const clearOrder =
      files.clearWorkspaceCollections.mock.invocationCallOrder[0];
    const reseedOrder =
      files.getOrCreateWorkspaceCollections.mock.invocationCallOrder.at(-1);
    expect(reseedOrder).toBeGreaterThan(clearOrder!);
  });

  it("double-close returns the same in-flight teardown", async () => {
    openWorkspace("/ws");
    const first = closeWorkspace("/ws");
    const second = closeWorkspace("/ws");
    expect(second).toBe(first);
    await first;
    expect(openWorkspacesCollection.size).toBe(0);
  });
});

describe("closeAllWorkspaces", () => {
  it("closes every open workspace", async () => {
    openWorkspace("/ws-a");
    openWorkspace("/ws-b");

    await closeAllWorkspaces();

    expect(isWorkspaceOpen("/ws-a")).toBe(false);
    expect(isWorkspaceOpen("/ws-b")).toBe(false);
    expect(openWorkspacesCollection.size).toBe(0);
  });
});
