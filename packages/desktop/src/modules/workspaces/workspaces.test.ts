import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineModule, type Core } from "@notefig/core";
import { workspacesModule, type WorkspaceRegistry } from "@/modules/workspaces";
import { workspaceAgentsModule } from "@/modules/agents/workspace-agents";
import {
  agentStoreModule,
  type AgentStore,
  type AgentTaskRow,
} from "@/modules/agents/agent-collections";
import { createTestCore } from "@/testing/test-core";
import { kvModule } from "@/modules/kv";

// When core opens a workspace's modules: a stand-in for its files, which
// start themselves (their walk and watch are the files suite's business),
// and record their disposal — the per-workspace state core tears down when
// the row goes.
const files = {
  created: vi.fn((_path: string) => {}),
  disposed: vi.fn((_path: string) => {}),
};
// A history module that records its disposal: what core runs when it
// closes the workspace.
const history = { disposed: vi.fn((_path: string) => {}) };
// No file-sync stand-in: watcher lifetime left the registry in MET-183. The
// registry publishes membership and nothing else; arming, stopping and
// re-arming are covered by utils/__tests__/workspace-watchers.test.ts.

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
// real module, over a real in-memory SQLite, so a close's
// demote-to-restored runs the production path end to end), then the
// history repo and the files. The agents' app-wide neighbours that a close
// never reaches (tabs, documents) are inert stand-ins.
let core: Core;
let registry: WorkspaceRegistry;
let tasks: AgentStore["tasks"];

beforeEach(async () => {
  vi.clearAllMocks();
  core = createTestCore({
    modules: [
      defineModule({
        name: "files",
        workspace: {
          create: ({ workspace }) => {
            files.created(workspace.path);
            return {} as never;
          },
          dispose: (_files, workspace) => files.disposed(workspace.path),
        },
      }),
      defineModule({
        name: "history",
        workspace: {
          create: () => ({}) as never,
          dispose: (_history, workspace) => history.disposed(workspace.path),
        },
      }),
      defineModule({ name: "tabs", register: () => ({}) as never }),
      defineModule({ name: "documents", register: () => ({}) as never }),
      defineModule({ name: "editors", register: () => ({}) as never }),
      kvModule,
      agentStoreModule,
      workspacesModule,
      workspaceAgentsModule,
    ],
  });
  core.boot();
  registry = core.use("workspaceRegistry");
  tasks = core.use("agentStore").tasks;
  await tasks.preload();
});

afterEach(async () => {
  await core.dispose();
});

/** Bring a workspace forward the way the switcher does: through its handle,
 *  which the registry turns into a row. */
const focus = (path: string) => core.workspace(path).focus();
const close = (path: string) => core.workspace(path).close();

describe("focusing a workspace", () => {
  it("joins the open set: the row goes in, and core opens its modules", async () => {
    await focus("/ws");

    expect(files.created).toHaveBeenCalledWith("/ws");
    expect(registry.isOpen("/ws")).toBe(true);
    expect([...registry.collection.values()]).toMatchObject([{ path: "/ws" }]);
  });

  it("re-entry keeps one row and one set of modules", async () => {
    await focus("/ws");
    await focus("/ws");
    // Same workspace under a respelled path collapses onto one entry.
    await focus("/ws/");

    expect(files.created).toHaveBeenCalledTimes(1);
    expect(registry.collection.size).toBe(1);
  });

  it("re-entry brings the workspace to the front: focusedAt rises above every other row", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      await focus("/ws-a");
      vi.setSystemTime(2_000);
      await focus("/ws-b");
      vi.setSystemTime(3_000);
      await focus("/ws-a");

      const byFocus = [...registry.collection.values()].sort(
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

    expect(registry.collection.size).toBe(2);
    expect(registry.isOpen("/ws-a")).toBe(true);
    expect(registry.isOpen("/ws-b")).toBe(true);
  });
});

describe("closing a workspace", () => {
  it("tears down every per-workspace subsystem and drops the row", async () => {
    // Every per-workspace value is a core workspace module, closed by core
    // when the row goes.
    await focus("/ws");

    await close("/ws");

    expect(history.disposed).toHaveBeenCalledWith("/ws");
    expect(files.disposed).toHaveBeenCalledTimes(1);
    expect(files.disposed).toHaveBeenCalledWith("/ws");
    expect(registry.isOpen("/ws")).toBe(false);
    expect(registry.collection.size).toBe(0);
  });

  it("demotes sessionful task rows to restored and purges sessionless ones (MET-54 contract)", async () => {
    await focus("/ws");
    await tasks.insert(taskRow({ status: "running" })).isPersisted.promise;
    await tasks.insert(
      taskRow({ taskId: "task_b", sessionId: undefined, status: "error" }),
    ).isPersisted.promise;
    // A neighbouring workspace's row must be untouched by the close.
    await tasks.insert(
      taskRow({ taskId: "task_other", workspacePath: "/other" }),
    ).isPersisted.promise;

    await close("/ws");

    expect(tasks.get("task_a")).toMatchObject({
      status: "restored",
    });
    expect(tasks.get("task_b")).toBeUndefined();
    expect(tasks.get("task_other")).toMatchObject({
      status: "idle",
    });
  });

  it("is a no-op for a workspace that is not open", async () => {
    await expect(close("/never-opened")).resolves.toBeUndefined();
    expect(registry.collection.size).toBe(0);
  });
});

describe("close/reopen race", () => {
  it("a reopen during an in-flight close waits for the teardown, then opens fresh", async () => {
    await focus("/ws");
    await tasks.insert(taskRow({ status: "running" })).isPersisted.promise;

    const closing = close("/ws");
    // Synchronous effects of close land immediately…
    expect(registry.isOpen("/ws")).toBe(false);
    expect(registry.collection.size).toBe(0);

    // …and a reopen issued mid-teardown neither throws nor interleaves.
    await focus("/ws");
    await closing;
    await Promise.resolve();

    expect(registry.isOpen("/ws")).toBe(true);
    expect(registry.collection.size).toBe(1);
    // The close's teardown ran (row demoted), and the reopen re-seeded
    // collections after it — not before.
    expect(tasks.get("task_a")).toMatchObject({
      status: "restored",
    });
    const disposeOrder = files.disposed.mock.invocationCallOrder[0];
    const reseedOrder = files.created.mock.invocationCallOrder.at(-1);
    expect(reseedOrder).toBeGreaterThan(disposeOrder!);
  });

  it("double-close returns the same in-flight teardown", async () => {
    await focus("/ws");
    const first = close("/ws");
    const second = close("/ws");
    expect(second).toBe(first);
    await first;
    expect(registry.collection.size).toBe(0);
  });
});

describe("workspaceOf", () => {
  it("resolves by tree membership, never by string prefix", async () => {
    await focus("/ws");
    await focus("/ws-backup");

    expect(registry.workspaceOf("/ws/a.md")).toBe("/ws");
    expect(registry.workspaceOf("/ws-backup/x.md")).toBe("/ws-backup");
    expect(registry.workspaceOf("/ws")).toBe("/ws");
  });

  it("picks the deepest of nested open workspaces", async () => {
    await focus("/ws");
    await focus("/ws/inner");

    expect(registry.workspaceOf("/ws/inner/y.md")).toBe("/ws/inner");
    expect(registry.workspaceOf("/ws/top.md")).toBe("/ws");
  });

  it("is null for a path no open workspace contains", async () => {
    await focus("/ws");

    expect(registry.workspaceOf("/elsewhere/z.md")).toBeNull();
  });
});
