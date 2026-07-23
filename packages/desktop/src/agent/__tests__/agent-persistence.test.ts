import { describe, it, expect, vi, beforeEach } from "vitest";

// Map-backed adapter mock: the storage-backed tasks collection reads and
// writes through this "disk", so tests exercise the real write-through +
// boot-mapping behavior end to end.
const { kvBackend, setKv, deleteKv, transportFactory } = vi.hoisted(() => {
  const kvBackend = new Map<string, unknown>(); // "<namespace>:<key>"
  return {
    kvBackend,
    setKv: vi.fn(async (namespace: string, key: string, value: unknown) => {
      kvBackend.set(`${namespace}:${key}`, value);
    }),
    deleteKv: vi.fn(async (namespace: string, key: string) => {
      kvBackend.delete(`${namespace}:${key}`);
    }),
    transportFactory: { current: null as null | (() => unknown) },
  };
});
vi.mock("@/adapters", () => ({
  platformAdapter: {
    setKv,
    deleteKv,
    getKv: vi.fn(async (namespace: string, key: string) =>
      kvBackend.get(`${namespace}:${key}`),
    ),
    getAllKv: vi.fn(async (namespace: string) => {
      const out: Record<string, unknown> = {};
      for (const [full, value] of kvBackend) {
        if (full.startsWith(`${namespace}:`)) {
          out[full.slice(namespace.length + 1)] = value;
        }
      }
      return out;
    }),
    writeFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
    readFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
    deleteFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths,
      failed: [],
    })),
    createMcpEndpoint: vi.fn(() => ({
      mcpServer: undefined,
      start: vi.fn(async () => {}),
      onRequest: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    })),
    createAgentTransport: vi.fn(() => transportFactory.current!()),
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "./fake-agent";
import {
  AGENT_TASKS_NAMESPACE,
  bootAgentTaskRow,
  parsePersistedAgentTasks,
  persistableAgentTaskRow,
} from "../agent-persistence";
import {
  deleteAgentSession,
  disposeWorkspaceTaskManager,
  promptAgentTask,
  reviveAgentTask,
} from "../agent-service";
import {
  agentEntriesCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentTaskRow,
} from "../agent-collections";
import { registerTask, unregisterTask } from "../task-registry";
import type { AgentTask } from "../agent-service";

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

function seedDisk(overrides: Partial<AgentTaskRow> = {}): void {
  const row = taskRow(overrides);
  kvBackend.set(`${AGENT_TASKS_NAMESPACE}:${row.taskId}`, row);
}

function onDisk(taskId: string): unknown {
  return kvBackend.get(`${AGENT_TASKS_NAMESPACE}:${taskId}`);
}

async function refetch(): Promise<void> {
  await agentTasksCollection.utils.refetch();
}

beforeEach(async () => {
  transportFactory.current = null;
  for (const e of agentEntriesCollection.toArray) agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) {
    unregisterTask(t.taskId);
    agentTasksCollection.delete(t.taskId);
  }
  kvBackend.clear();
  setKv.mockClear();
  deleteKv.mockClear();
  await agentTasksCollection.preload(); // start the collection (idempotent)
  await refetch();
});

describe("pure helpers", () => {
  it("parsePersistedAgentTasks keeps valid rows, drops garbage", () => {
    const rows = parsePersistedAgentTasks({
      good: taskRow(),
      junk: "hello",
      alsoJunk: null,
      missingFields: { taskId: "task_x" },
    });
    expect(rows.map((r) => r.taskId)).toEqual(["task_a"]);
  });

  it("accepts status-less rows written by the pre-full-row design", () => {
    const { status: _dropped, ...legacy } = taskRow();
    const rows = parsePersistedAgentTasks({ legacy });
    expect(rows).toHaveLength(1);
    expect(bootAgentTaskRow(rows[0])).toMatchObject({
      taskId: "task_a",
      status: "restored",
    });
  });

  it("bootAgentTaskRow maps to restored and drops runtime-only fields", () => {
    const boot = bootAgentTaskRow({
      ...taskRow({ status: "running" }),
      authRequired: true,
      authHint: "hint",
    });
    expect(boot).toEqual(taskRow({ status: "restored" }));
    expect(bootAgentTaskRow(taskRow({ sessionId: undefined }))).toBeNull();
  });

  it("persistableAgentTaskRow strips TanStack's $-virtual props", () => {
    const cleaned = persistableAgentTaskRow({
      ...taskRow(),
      $synced: true,
      $origin: "local",
    } as unknown as AgentTaskRow);
    expect(Object.keys(cleaned).some((k) => k.startsWith("$"))).toBe(false);
    expect(cleaned.taskId).toBe("task_a");
  });
});

describe("storage-backed tasks collection", () => {
  it("boot load maps dead sessionful rows to restored, drops sessionless ones", async () => {
    seedDisk({ status: "running" });
    seedDisk({ taskId: "task_never", sessionId: undefined, status: "error" });
    await refetch();

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
      title: "Rewrite chapter 3",
    });
    expect(agentTasksCollection.get("task_never")).toBeUndefined();
  });

  it("a refetch never clobbers a task with a live runtime", async () => {
    seedDisk({ status: "running" });
    registerTask({ taskId: "task_a" } as unknown as AgentTask);
    await refetch();
    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "running",
    });
    unregisterTask("task_a");
  });

  it("a foreign status on a live task's stored row falls back to the runtime status", async () => {
    // kv.json is hand-editable; a garbage status must not enter the union.
    seedDisk({ status: "bogus" as AgentTaskRow["status"] });
    registerTask({
      taskId: "task_a",
      currentStatus: "running",
    } as unknown as AgentTask);
    await refetch();
    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "running",
    });
    unregisterTask("task_a");
  });

  it("a failed KV write never rolls back the in-memory row", async () => {
    setKv.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    agentTasksCollection.insert(taskRow());
    await vi.waitFor(() => {
      // Memory keeps the row (no optimistic rollback); disk missed the write.
      expect(agentTasksCollection.get("task_a")).toMatchObject({ status: "idle" });
    });
    expect(onDisk("task_a")).toBeUndefined();

    // The next write-through repairs the disk.
    agentTasksCollection.update("task_a", (draft) => {
      draft.status = "running";
    });
    await vi.waitFor(() => {
      expect(onDisk("task_a")).toMatchObject({ status: "running" });
    });
  });

  it("mutations write through: insert/update persist a clean row, delete removes it", async () => {
    agentTasksCollection.insert(taskRow());
    expect(onDisk("task_a")).toMatchObject({ taskId: "task_a", status: "idle" });
    expect(
      Object.keys(onDisk("task_a") as object).some((k) => k.startsWith("$")),
    ).toBe(false);

    agentTasksCollection.update("task_a", (draft) => {
      draft.status = "running";
    });
    expect(onDisk("task_a")).toMatchObject({ status: "running" });

    agentTasksCollection.delete("task_a");
    expect(onDisk("task_a")).toBeUndefined();
  });
});

describe("lifecycle", () => {
  it("workspace dispose demotes sessionful rows to restored (persisted), drops sessionless", async () => {
    agentTasksCollection.insert(taskRow({ status: "idle" }));
    agentTasksCollection.insert(
      taskRow({ taskId: "task_never", sessionId: undefined, status: "error" }),
    );

    await disposeWorkspaceTaskManager("/ws");

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    expect(agentTasksCollection.get("task_never")).toBeUndefined();
    expect(onDisk("task_a")).toMatchObject({ status: "restored" });
    expect(onDisk("task_never")).toBeUndefined();
  });

  it("deleteAgentSession removes the row, its transcript rows, and the disk row", async () => {
    agentTasksCollection.insert(taskRow({ status: "unavailable" }));
    agentEntriesCollection.insert({
      id: "evt_1",
      taskId: "task_a",
      turnId: "trn_1",
      type: "user",
      text: "hello",
      createdAt: 1,
    });
    agentTurnsCollection.insert({
      turnId: "trn_1",
      taskId: "task_a",
      sessionId: "sess_1",
      status: "completed",
      startedAt: 1,
    });

    await deleteAgentSession("task_a");

    expect(agentTasksCollection.get("task_a")).toBeUndefined();
    expect(agentEntriesCollection.toArray.filter((e) => e.taskId === "task_a")).toEqual([]);
    expect(agentTurnsCollection.toArray.filter((t) => t.taskId === "task_a")).toEqual([]);
    expect(onDisk("task_a")).toBeUndefined();
  });
});

describe("revival via session/load", () => {
  function restoredRow(): void {
    // The same shape a boot load produces (write-through persists it too —
    // harmless, matches disk exactly).
    agentTasksCollection.insert(taskRow({ status: "restored" }));
  }

  it("replays history into the transcript and leaves the task promptable", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    transportFactory.current = () => client;
    agent.onLoadSession = async (params, a) => {
      a.update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "original prompt" },
      });
      a.update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read",
        status: "completed",
        rawInput: { file_path: "readme.md" },
      });
      a.update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "original reply" },
      });
      return {};
    };

    const revival = reviveAgentTask("task_a");
    expect(revival).not.toBeNull();
    await revival!.started;

    expect(agent.loadSessionParams).toMatchObject({ sessionId: "sess_1" });
    const entries = agentEntriesCollection.toArray
      .filter((e) => e.taskId === "task_a")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_call", "assistant"]);
    // Replayed entries carry NO createdAt (MET-94): ACP has no timestamps,
    // and a revival-time stamp would lie.
    expect(entries.map((e) => e.createdAt)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(agentTasksCollection.get("task_a")!.status).toBe("idle");

    agent.onPrompt = async () => ({ stopReason: "end_turn" });
    promptAgentTask("task_a", "follow-up");
    await vi.waitFor(() => {
      const turns = agentTurnsCollection.toArray.filter(
        (t) => t.taskId === "task_a" && t.stopReason === "end_turn",
      );
      expect(turns.length).toBe(1);
    });
    // …while live entries after the revival are stamped as usual.
    const liveUser = agentEntriesCollection.toArray.find(
      (e) => e.taskId === "task_a" && e.text === "follow-up",
    );
    expect(liveUser?.createdAt).toBeTypeOf("number");
    await disposeWorkspaceTaskManager("/ws");
  });

  it("prompting a restored task revives it and queues the prompt", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    transportFactory.current = () => client;
    agent.onLoadSession = async () => ({});
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    promptAgentTask("task_a", "wake up");

    await vi.waitFor(() => {
      const turns = agentTurnsCollection.toArray.filter(
        (t) => t.taskId === "task_a",
      );
      expect(turns.some((t) => t.status === "completed")).toBe(true);
    });
    await disposeWorkspaceTaskManager("/ws");
  });

  it("a failed session/load lands the row on unavailable and errors queued prompts", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    transportFactory.current = () => client;
    agent.onLoadSession = async () => {
      throw new Error("session gone");
    };

    promptAgentTask("task_a", "wake up");

    await vi.waitFor(() => {
      expect(agentTasksCollection.get("task_a")!.status).toBe("unavailable");
      const turns = agentTurnsCollection.toArray.filter(
        (t) => t.taskId === "task_a",
      );
      expect(turns.some((t) => t.status === "error")).toBe(true);
    });
    // The disk row survives (delete is the user's call), and a later boot
    // load would map it straight back to "restored" for a retry.
    expect(onDisk("task_a")).toBeDefined();
    await disposeWorkspaceTaskManager("/ws");
  });

  it("a failed start tears its transport down instead of leaking the process", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const close = vi.spyOn(client, "close");
    transportFactory.current = () => client;
    agent.onLoadSession = async () => {
      throw new Error("session gone");
    };

    await reviveAgentTask("task_a")!.started.catch(() => {});

    expect(close).toHaveBeenCalled();
    // The close event fired by our own teardown must not stomp the
    // "unavailable" verdict either (handleTransportClose keeps it).
    expect(agentTasksCollection.get("task_a")!.status).toBe("unavailable");
    await disposeWorkspaceTaskManager("/ws");
  });

  it("a dispose mid-revival never stomps the demoted row (StrictMode boot)", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let release: (() => void) | undefined;
    agent.onLoadSession = () =>
      new Promise<Record<string, never>>((resolve) => {
        release = () => resolve({});
      });
    transportFactory.current = () => client;

    const revival = reviveAgentTask("task_a")!;
    // Workspace teardown lands while session/load is still in flight — the
    // exact StrictMode boot sequence. The late start() failure must not
    // write "error" over the demoted row.
    await disposeWorkspaceTaskManager("/ws");
    release?.();
    await Promise.race([
      revival.started.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
  });

  it("re-reviving after a workspace close does not duplicate the transcript", async () => {
    restoredRow();
    const replay = async (params: { sessionId: string }, a: FakeAgent) => {
      a.update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "original prompt" },
      });
      a.update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "original reply" },
      });
      return {};
    };
    const [client1, agentSide1] = createLoopbackPair();
    const agent1 = new FakeAgent(agentSide1);
    agent1.onLoadSession = replay;
    transportFactory.current = () => client1;
    await reviveAgentTask("task_a")!.started;

    await disposeWorkspaceTaskManager("/ws"); // demotes back to "restored"

    const [client2, agentSide2] = createLoopbackPair();
    const agent2 = new FakeAgent(agentSide2);
    agent2.onLoadSession = replay;
    transportFactory.current = () => client2;
    await reviveAgentTask("task_a")!.started;

    const entries = agentEntriesCollection.toArray.filter(
      (e) => e.taskId === "task_a" && e.type !== "unknown",
    );
    expect(entries.map((e) => e.type).sort()).toEqual(["assistant", "user"]);
    await disposeWorkspaceTaskManager("/ws");
  });

  it("reviveAgentTask is a no-op for unknown or non-restored tasks", () => {
    expect(reviveAgentTask("task_missing")).toBeNull();
    agentTasksCollection.insert(taskRow({ status: "error" }));
    expect(reviveAgentTask("task_a")).toBeNull();
  });
});