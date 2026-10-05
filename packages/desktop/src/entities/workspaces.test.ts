import { describe, it, expect, vi, beforeEach } from "vitest";

// Same rig as agent-persistence.test.ts: the tasks collection persists into
// a real in-memory SQLite via the desktop driver, so a close's
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
  workspaceCollections: { drop: vi.fn() },
}));
vi.mock("@/entities/files", () => files);
const history = vi.hoisted(() => ({
  disposeWorkspaceHistoryService: vi.fn(),
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));
// The history module, over the mocked dispose: what core runs when it
// closes the workspace.
vi.mock("@/utils/history-service", async () => {
  const { defineModule } = await import("@notefig/core");
  return {
    ...history,
    historyModule: defineModule({
      name: "history",
      workspace: {
        create: () => ({}) as never,
        dispose: (_history, workspace) =>
          history.disposeWorkspaceHistoryService(workspace.path),
      },
    }),
  };
});
// No file-sync mock: watcher lifetime left the registry in MET-183. The
// registry publishes membership and nothing else; arming, stopping and
// re-arming are covered by utils/__tests__/workspace-watchers.test.ts.

import {
  startWorkspaceScopeSubscription,
  workspaceScoped,
} from "./workspace-scoped";
import {
  isWorkspaceOpen,
  openWorkspacesCollection,
  workspaceOfPath,
  workspacesModule,
} from "./workspaces";
import { defineModule } from "@notefig/core";
import { workspaceAgentsModule } from "@/agent/workspace-agents";
import { historyModule } from "@/utils/history-service";
import { createTestCore } from "@/testing/test-core";
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

// Core closes each workspace's modules when its row goes: the agents (the
// real module), then the history repo. Scopes and watchers are the tests'
// own business here (see the workspace-scoped and watcher suites).
const core = createTestCore({
  modules: [
    defineModule({ name: "workspace-scopes" }),
    defineModule({ name: "workspace-watchers" }),
    workspacesModule({ restore: false }),
    historyModule,
    workspaceAgentsModule,
  ],
});
core.boot();

/** Bring a workspace forward the way the switcher does: through its handle,
 *  which the registry turns into a row. */
const focus = (path: string) => core.workspace(path).focus();
const close = (path: string) => core.workspace(path).close();

beforeEach(async () => {
  dbRef.current!.repairWrites();
  vi.clearAllMocks();
  for (const row of [...openWorkspacesCollection.values()]) {
    await close(row.path);
  }
  vi.clearAllMocks();
  for (const t of agentTasksCollection.toArray) {
    unregisterTask(t.taskId);
    await agentTasksCollection.delete(t.taskId).isPersisted.promise;
  }
  await agentTasksCollection.preload();
});

describe("focusing a workspace", () => {
  it("seeds collections, refreshes, inserts the row", async () => {
    await focus("/ws");

    expect(files.getOrCreateWorkspaceCollections).toHaveBeenCalledWith("/ws");
    expect(files.refreshDirectoryMetadata).toHaveBeenCalledWith("/ws");
    expect(isWorkspaceOpen("/ws")).toBe(true);
    expect([...openWorkspacesCollection.values()]).toMatchObject([
      { path: "/ws" },
    ]);
  });

  it("re-entry refreshes the listing but never re-seeds", async () => {
    await focus("/ws");
    await focus("/ws");
    // Same workspace under a respelled path collapses onto one entry.
    await focus("/ws/");

    expect(files.getOrCreateWorkspaceCollections).toHaveBeenCalledTimes(1);
    expect(files.refreshDirectoryMetadata).toHaveBeenCalledTimes(3);
    expect(openWorkspacesCollection.size).toBe(1);
  });

  it("re-entry brings the workspace to the front: focusedAt rises above every other row", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      await focus("/ws-a");
      vi.setSystemTime(2_000);
      await focus("/ws-b");
      vi.setSystemTime(3_000);
      await focus("/ws-a");

      const byFocus = [...openWorkspacesCollection.values()].sort(
        (a, b) => b.focusedAt - a.focusedAt,
      );
      expect(byFocus.map((row) => row.path)).toEqual(["/ws-a", "/ws-b"]);
      expect(byFocus[0]?.focusedAt).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps independent entries per workspace", async () => {
    await focus("/ws-a");
    await focus("/ws-b");

    expect(openWorkspacesCollection.size).toBe(2);
    expect(isWorkspaceOpen("/ws-a")).toBe(true);
    expect(isWorkspaceOpen("/ws-b")).toBe(true);
  });
});

describe("closing a workspace", () => {
  it("tears down every per-workspace subsystem and drops the row", async () => {
    // The OS-resource owners are core workspace modules, closed by core;
    // everything else is scoped to membership and disposes itself when the
    // row goes (the real helper, not a mock).
    const stopScopes = startWorkspaceScopeSubscription();
    const dispose = vi.fn();
    const scope = workspaceScoped({ create: () => ({}), dispose });
    try {
      await focus("/ws");
      scope.get("/ws");

      await close("/ws");

      expect(history.disposeWorkspaceHistoryService).toHaveBeenCalledWith("/ws");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(scope.get("/ws")).toBeUndefined();
      expect(isWorkspaceOpen("/ws")).toBe(false);
      expect(openWorkspacesCollection.size).toBe(0);
    } finally {
      stopScopes();
    }
  });

  it("demotes sessionful task rows to restored and purges sessionless ones (MET-54 contract)", async () => {
    await focus("/ws");
    await agentTasksCollection.insert(taskRow({ status: "running" }))
      .isPersisted.promise;
    await agentTasksCollection.insert(
      taskRow({ taskId: "task_b", sessionId: undefined, status: "error" }),
    ).isPersisted.promise;
    // A neighbouring workspace's row must be untouched by the close.
    await agentTasksCollection.insert(
      taskRow({ taskId: "task_other", workspacePath: "/other" }),
    ).isPersisted.promise;

    await close("/ws");

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    expect(agentTasksCollection.get("task_b")).toBeUndefined();
    expect(agentTasksCollection.get("task_other")).toMatchObject({
      status: "idle",
    });
  });

  it("is a no-op for a workspace that is not open", async () => {
    await expect(close("/never-opened")).resolves.toBeUndefined();
    expect(openWorkspacesCollection.size).toBe(0);
  });
});

describe("close/reopen race", () => {
  it("a reopen during an in-flight close waits for the teardown, then opens fresh", async () => {
    const stopScopes = startWorkspaceScopeSubscription();
    const dispose = vi.fn();
    const scope = workspaceScoped({ create: () => ({}), dispose });
    await focus("/ws");
    scope.get("/ws");
    await agentTasksCollection.insert(taskRow({ status: "running" }))
      .isPersisted.promise;

    const closing = close("/ws");
    // Synchronous effects of close land immediately…
    expect(isWorkspaceOpen("/ws")).toBe(false);
    expect(openWorkspacesCollection.size).toBe(0);

    // …and a reopen issued mid-teardown neither throws nor interleaves.
    await focus("/ws");
    await closing;
    await Promise.resolve();

    expect(isWorkspaceOpen("/ws")).toBe(true);
    expect(openWorkspacesCollection.size).toBe(1);
    // The close's teardown ran (row demoted), and the reopen re-seeded
    // collections after it — not before.
    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    const disposeOrder = dispose.mock.invocationCallOrder[0];
    const reseedOrder =
      files.getOrCreateWorkspaceCollections.mock.invocationCallOrder.at(-1);
    expect(reseedOrder).toBeGreaterThan(disposeOrder!);
    stopScopes();
  });

  it("double-close returns the same in-flight teardown", async () => {
    await focus("/ws");
    const first = close("/ws");
    const second = close("/ws");
    expect(second).toBe(first);
    await first;
    expect(openWorkspacesCollection.size).toBe(0);
  });
});

describe("workspaceOfPath", () => {
  it("resolves by tree membership, never by string prefix", async () => {
    await focus("/ws");
    await focus("/ws-backup");

    expect(workspaceOfPath("/ws/a.md")).toBe("/ws");
    expect(workspaceOfPath("/ws-backup/x.md")).toBe("/ws-backup");
    expect(workspaceOfPath("/ws")).toBe("/ws");
  });

  it("picks the deepest of nested open workspaces", async () => {
    await focus("/ws");
    await focus("/ws/inner");

    expect(workspaceOfPath("/ws/inner/y.md")).toBe("/ws/inner");
    expect(workspaceOfPath("/ws/top.md")).toBe("/ws");
  });

  it("is null for a path no open workspace contains", async () => {
    await focus("/ws");

    expect(workspaceOfPath("/elsewhere/z.md")).toBeNull();
  });
});
