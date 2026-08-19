import { describe, it, expect, vi, beforeEach } from "vitest";

// The tasks collection persists into a real (in-memory) SQLite through the
// same driver the desktop uses, so these tests exercise write-through and the
// boot mapping end to end rather than against a stub.
const { dbRef, transportFactory } = vi.hoisted(() => ({
  dbRef: { current: null as null | import("@/testing/node-db").NodeTestDb },
  transportFactory: { current: null as null | (() => unknown) },
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
      createAgentTransport: vi.fn(() => transportFactory.current!()),
    },
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "../mock-harness";
import {
  AGENT_TASKS_COLLECTION_ID,
  bootAgentTaskRow,
  parsePersistedAgentTask,
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
  reconcileAgentTasksAtBoot,
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

/** A row as a previous session would have left it behind in storage. */
async function seedDisk(overrides: Partial<AgentTaskRow> = {}): Promise<void> {
  await agentTasksCollection.insert(taskRow(overrides)).isPersisted.promise;
}

function onDisk(taskId: string): Record<string, unknown> | undefined {
  return dbRef
    .current!.storedRows(AGENT_TASKS_COLLECTION_ID)
    .find((row) => row.key === taskId)?.value;
}

/** What App.tsx runs at startup, once the collection has hydrated. */
async function boot(): Promise<void> {
  await reconcileAgentTasksAtBoot();
}

beforeEach(async () => {
  // Before the cleanup below, not after: a still-broken db would fail these
  // deletes and leak rows into the next test.
  dbRef.current!.repairWrites();
  transportFactory.current = null;
  for (const e of agentEntriesCollection.toArray)
    agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray)
    agentTurnsCollection.delete(t.turnId);
  // Awaited to durability, unlike the two above: the tasks collection is the
  // persisted one, and a delete still in flight when a test breaks writes would
  // roll back and resurrect the row.
  for (const t of agentTasksCollection.toArray) {
    unregisterTask(t.taskId);
    await agentTasksCollection.delete(t.taskId).isPersisted.promise;
  }
  await agentTasksCollection.preload(); // start the collection (idempotent)
});

describe("pure helpers", () => {
  it("parsePersistedAgentTask keeps a valid row, drops garbage", () => {
    expect(parsePersistedAgentTask(taskRow())?.taskId).toBe("task_a");
    for (const junk of ["hello", null, { taskId: "task_x" }]) {
      expect(parsePersistedAgentTask(junk)).toBeNull();
    }
  });

  it("accepts status-less rows written by the pre-full-row design", () => {
    const { status: _dropped, ...legacy } = taskRow();
    const parsed = parsePersistedAgentTask(legacy);
    expect(parsed).not.toBeNull();
    expect(bootAgentTaskRow(parsed!)).toMatchObject({
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

});

describe("persisted tasks collection", () => {
  it("boot demotes dead sessionful rows to restored and drops sessionless ones", async () => {
    await seedDisk({ status: "running" });
    await seedDisk({
      taskId: "task_never",
      sessionId: undefined,
      status: "error",
    });

    await boot();

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
      title: "Rewrite chapter 3",
    });
    // Nothing to revive without a session — and it leaves storage too, rather
    // than lingering as a row no boot will ever surface.
    expect(agentTasksCollection.get("task_never")).toBeUndefined();
    expect(onDisk("task_never")).toBeUndefined();
  });

  it("boot drops runtime-only fields along with the demotion", async () => {
    await seedDisk({ status: "running", authHint: "run `claude login`" });

    await boot();

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
    // In memory the key lingers holding `undefined` — the strip is an
    // assignment, because a draft ignores `delete` and a delete-then-insert
    // pair could not be made atomic. Every consumer reads that as absent...
    expect(agentTasksCollection.get("task_a")!.authHint).toBeUndefined();
    // ...and it really is absent in storage, so the next launch loads the
    // clean boot shape.
    expect(onDisk("task_a")).not.toHaveProperty("authHint");
  });

  it("boot never clobbers a task with a live runtime", async () => {
    await seedDisk({ status: "running" });
    registerTask({ taskId: "task_a" } as unknown as AgentTask);

    await boot();

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "running",
    });
    unregisterTask("task_a");
  });

  it("a foreign status on a live task's stored row falls back to the runtime status", async () => {
    // The schema only validates status as a string, so a row written by a
    // future/older build must not smuggle a value into the union.
    await seedDisk({ status: "bogus" as AgentTaskRow["status"] });
    registerTask({
      taskId: "task_a",
      currentStatus: "running",
    } as unknown as AgentTask);

    await boot();

    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "running",
    });
    unregisterTask("task_a");
  });

  it("boot deletes a stored row that no longer validates", async () => {
    await seedDisk();
    // Corrupt it the way an older build or a schema change would.
    await agentTasksCollection.update("task_a", (draft) => {
      (draft as unknown as { workspacePath: unknown }).workspacePath = 42;
    }).isPersisted.promise;

    await boot();

    expect(agentTasksCollection.get("task_a")).toBeUndefined();
    expect(onDisk("task_a")).toBeUndefined();
  });

  it("boot is idempotent — a second run changes nothing", async () => {
    await seedDisk({ status: "running" });
    await boot();
    const afterFirst = onDisk("task_a");

    await boot();

    expect(onDisk("task_a")).toEqual(afterFirst);
    expect(agentTasksCollection.get("task_a")).toMatchObject({
      status: "restored",
    });
  });

  it("rolls a mutation back when the write cannot be committed", async () => {
    // The tradeoff MET-124 accepted: the persistence wrapper commits after our
    // handlers and its throw is not interceptable, so persistence is no longer
    // best-effort. Asserted rather than assumed, because it is a behavior
    // change from the KV era.
    dbRef.current!.breakWrites("disk full");

    await expect(
      agentTasksCollection.insert(taskRow()).isPersisted.promise,
    ).rejects.toThrow(/disk full/);

    // The rollback lands after the rejection settles.
    await vi.waitFor(() => {
      expect(agentTasksCollection.get("task_a")).toBeUndefined();
    });
  });

  it("mutations persist a clean row, and delete removes it", async () => {
    await agentTasksCollection.insert(taskRow()).isPersisted.promise;
    expect(onDisk("task_a")).toMatchObject({
      taskId: "task_a",
      status: "idle",
    });
    // TanStack's enumerable `$`-virtuals (`$origin`, `$synced`, …) must not
    // reach storage. The wrapper gives us no hook to strip them, so if upstream
    // ever starts persisting them this is what catches it.
    expect(
      Object.keys(onDisk("task_a")!).some((key) => key.startsWith("$")),
    ).toBe(false);

    await agentTasksCollection.update("task_a", (draft) => {
      draft.status = "running";
    }).isPersisted.promise;
    expect(onDisk("task_a")).toMatchObject({ status: "running" });

    await agentTasksCollection.delete("task_a").isPersisted.promise;
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
    // dispose does not await durability — it demotes optimistically and lets
    // the commits land behind it.
    await vi.waitFor(() => {
      expect(onDisk("task_a")).toMatchObject({ status: "restored" });
      expect(onDisk("task_never")).toBeUndefined();
    });
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
    expect(
      agentEntriesCollection.toArray.filter((e) => e.taskId === "task_a"),
    ).toEqual([]);
    expect(
      agentTurnsCollection.toArray.filter((t) => t.taskId === "task_a"),
    ).toEqual([]);
    await vi.waitFor(() => expect(onDisk("task_a")).toBeUndefined());
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
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_call",
      "assistant",
    ]);
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

  it("replayed tool calls stuck pending/in_progress resolve as completed", async () => {
    restoredRow();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    transportFactory.current = () => client;
    // Adapters replay tool calls with whatever status they were snapshotted
    // at — a call that was mid-flight replays as in_progress (or with no
    // status at all) and nothing will ever finish it: the replay turn is
    // synthetic and no live turn boundary resolves its lingerers.
    agent.onLoadSession = async (params, a) => {
      a.update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc_pending",
        title: "Edit",
        status: "in_progress",
        rawInput: { file_path: "notes.md" },
      });
      a.update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc_statusless",
        title: "Read",
        rawInput: { file_path: "readme.md" },
      });
      a.update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc_failed",
        title: "Bash",
        status: "failed",
        rawInput: { command: "exit 1" },
      });
      return {};
    };

    await reviveAgentTask("task_a")!.started;

    const statuses = Object.fromEntries(
      agentEntriesCollection.toArray
        .filter((e) => e.taskId === "task_a" && e.type === "tool_call")
        .map((e) => [e.toolCallId, e.toolCall?.status]),
    );
    expect(statuses).toEqual({
      tc_pending: "completed",
      tc_statusless: "completed",
      // A terminal status replayed from history is kept, not overwritten.
      tc_failed: "failed",
    });
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
