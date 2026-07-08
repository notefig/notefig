import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the platform adapter singleton the write-gate and task service use.
// vi.hoisted so the fns exist before the hoisted vi.mock factory runs.
const { writeFiles, readFiles } = vi.hoisted(() => ({
  writeFiles: vi.fn(async (files: { path: string; content: string }[]) => ({
    succeeded: files.map((f) => f.path),
    failed: [] as unknown[],
  })),
  readFiles: vi.fn(async (paths: string[]) => ({
    succeeded: paths.map((p) => ({ path: p, content: "old contents\n" })),
    failed: [] as unknown[],
  })),
}));
vi.mock("@/adapters", () => ({
  platformAdapter: { setKv: vi.fn(), getKv: vi.fn(), writeFiles, readFiles },
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "./fake-agent";
import { TaskManager, respondToAgentPermission } from "../agent-service";
import {
  agentEventsCollection,
  agentMessagesCollection,
  agentPermissionRequestsCollection,
  agentTurnsCollection,
  agentTasksCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import type { AgentTask } from "../agent-service";

const harness = BUILT_IN_HARNESSES[0];

function textFor(taskId: string, role: "user" | "assistant"): string {
  const messageIds = new Set(
    agentMessagesCollection.toArray
      .filter((m) => m.taskId === taskId && m.role === role)
      .map((m) => m.messageId),
  );
  return agentEventsCollection.toArray
    .filter((e) => e.kind === "message_chunk" && messageIds.has(e.messageId))
    .map((e) => (e.payload as { text?: string }).text ?? "")
    .join("");
}

function turnFor(taskId: string) {
  return agentTurnsCollection.toArray
    .filter((t) => t.taskId === taskId)
    .sort((a, b) => (a.turnId < b.turnId ? -1 : 1));
}

function pendingPerms(taskId: string) {
  return agentPermissionRequestsCollection.toArray
    .filter((r) => r.taskId === taskId && r.status === "pending")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function toolEvents(taskId: string) {
  return agentEventsCollection.toArray.filter(
    (e) =>
      e.taskId === taskId &&
      (e.kind === "tool_call" || e.kind === "tool_call_update"),
  );
}

/** Fire a prompt (now fire-and-forget) and wait for its turn to settle. */
async function runPrompt(task: AgentTask, text: string): Promise<void> {
  const before = turnFor(task.taskId).length;
  task.prompt(text);
  await vi.waitFor(() => {
    const turns = turnFor(task.taskId);
    expect(turns.length).toBe(before + 1);
    expect(turns[turns.length - 1].status).not.toBe("running");
  });
}

beforeEach(() => {
  writeFiles.mockClear();
  readFiles.mockClear();
  for (const e of agentEventsCollection.toArray) agentEventsCollection.delete(e.id);
  for (const m of agentMessagesCollection.toArray) agentMessagesCollection.delete(m.messageId);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
});

describe("AgentTask vertical slice", () => {
  it("streams and coalesces an assistant turn", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_params, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      });
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "hi");

    expect(textFor(task.taskId, "user")).toBe("hi");
    expect(textFor(task.taskId, "assistant")).toContain("Hello world");
    expect(turnFor(task.taskId)[0].status).toBe("completed");
    expect(turnFor(task.taskId)[0].stopReason).toBe("end_turn");
  });

  it("routes agent file writes through the write gate", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_params, a) => {
      await a.request("fs/write_text_file", {
        sessionId: "sess_test",
        path: "/ws/README.md",
        content: "# New title\n",
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "edit the readme");

    expect(writeFiles).toHaveBeenCalledWith([
      { path: "/ws/README.md", content: "# New title\n" },
    ]);
  });

  it("publishes a permission request and settles it via the collection", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let outcome: unknown;
    agent.onPrompt = async (_params, a) => {
      const response = await a.request("session/request_permission", {
        sessionId: "sess_test",
        toolCall: { toolCallId: "call_1", title: "Write README.md" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      outcome = response.outcome;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    task.prompt("edit");

    await vi.waitFor(() => expect(pendingPerms(task.taskId).length).toBe(1));
    const head = pendingPerms(task.taskId)[0];
    respondToAgentPermission(task.taskId, head.id, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("completed"),
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    // Row left the pending set.
    expect(pendingPerms(task.taskId)).toHaveLength(0);
  });

  it("cancel resolves pending permissions as cancelled", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let outcome: unknown;
    agent.onPrompt = async (_params, a) => {
      const response = await a.request("session/request_permission", {
        sessionId: "sess_test",
        toolCall: { toolCallId: "call_2", title: "Dangerous op" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      outcome = response.outcome;
      return { stopReason: "cancelled" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    task.prompt("do it");

    await vi.waitFor(() => expect(pendingPerms(task.taskId).length).toBe(1));
    await task.cancel();

    await vi.waitFor(() => expect(outcome).toEqual({ outcome: "cancelled" }));
  });

  it("coalesces prompts sent during a running turn (latest wins)", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let promptCount = 0;
    agent.onPrompt = async (params, _a) => {
      seen.push(params.prompt[0].text);
      if (promptCount++ === 0) await firstGate; // hold the first turn open
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    task.prompt("first"); // starts a turn, gated open
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    task.prompt("second"); // both land in the single slot while running…
    task.prompt("third"); // …and the latest wins
    expect(seen).toEqual(["first"]); // nothing new delivered yet
    releaseFirst();

    await vi.waitFor(() => expect(seen).toEqual(["first", "third"]));
    expect(seen).not.toContain("second");
  });

  it("keeps parallel tasks isolated", async () => {
    const [clientA, agentA] = createLoopbackPair();
    const [clientB, agentB] = createLoopbackPair();
    const fakeA = new FakeAgent(agentA);
    const fakeB = new FakeAgent(agentB);
    fakeA.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "from A" },
      });
      return { stopReason: "end_turn" };
    };
    fakeB.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "from B" },
      });
      return { stopReason: "end_turn" };
    };

    const manager = new TaskManager("/ws");
    const taskA = manager.createTask(harness);
    const taskB = manager.createTask(harness);
    await taskA.start(clientA);
    await taskB.start(clientB);
    await Promise.all([runPrompt(taskA, "a"), runPrompt(taskB, "b")]);

    expect(textFor(taskA.taskId, "assistant")).toContain("from A");
    expect(textFor(taskB.taskId, "assistant")).toContain("from B");
    expect(textFor(taskA.taskId, "assistant")).not.toContain("from B");
  });

  it("marks the turn errored when the transport dies mid-turn", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = () => new Promise(() => {}); // never resolves

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    task.prompt("hang");

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    await client.close(); // simulate crash

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("error"),
    );
  });

  it("coalesces a tool call's updates into one row by toolCallId", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Write README.md",
        kind: "edit",
        status: "pending",
      });
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
      });
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "edit");

    const tools = toolEvents(task.taskId);
    expect(tools).toHaveLength(1); // one card, not four
    const payload = tools[0].payload as { status?: string; title?: string };
    expect(payload.status).toBe("completed"); // merged latest state
    expect(payload.title).toBe("Write README.md"); // kept from first update
  });

  it("stores the turn failure message on the turn row", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "go");

    const turn = turnFor(task.taskId)[0];
    expect(turn.status).toBe("error");
    expect(turn.error).toMatch(/authentication required/i);
  });

  it("does not run a coalesced prompt after the turn errors", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    agent.onPrompt = async (params) => {
      seen.push(params.prompt[0].text);
      await gate; // hold the first turn open so a second can be queued
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    task.prompt("one");
    await vi.waitFor(() => expect(seen).toEqual(["one"]));
    task.prompt("two"); // lands in the slot while the (failing) first runs
    releaseFirst();

    await vi.waitFor(() =>
      expect(turnFor(task.taskId).at(-1)?.status).toBe("error"),
    );
    // The drain halted on the error; "two" was not run.
    expect(seen).toEqual(["one"]);
  });

  it("ignores an unrendered session update without breaking the turn", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking about it" },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "go");

    expect(turnFor(task.taskId)[0].status).toBe("completed");
    // The thought chunk is not rendered, so no assistant message is created.
    expect(textFor(task.taskId, "assistant")).toBe("");
  });
});
