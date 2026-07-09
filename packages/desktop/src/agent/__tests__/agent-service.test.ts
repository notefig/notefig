import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the platform adapter singleton the file-sync helpers and task service use.
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
  agentEntriesCollection,
  agentInteractionsCollection,
  agentPermissionRequestsCollection,
  agentTurnsCollection,
  agentTasksCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import type { AgentTask } from "../agent-service";

const harness = BUILT_IN_HARNESSES[0];

/** Entries for a task in chronological (id) order. */
function entriesFor(taskId: string) {
  return agentEntriesCollection.toArray
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function textFor(taskId: string, role: "user" | "assistant"): string {
  return entriesFor(taskId)
    .filter((e) => e.type === role)
    .map((e) => e.text ?? "")
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

function toolEntries(taskId: string) {
  return entriesFor(taskId).filter((e) => e.type === "tool_call");
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
  for (const e of agentEntriesCollection.toArray) agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
  for (const i of agentInteractionsCollection.toArray)
    agentInteractionsCollection.delete(i.id);
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

  it("records unknown session updates as a catch-all entry (D4)", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const thought = { type: "text" as const, text: "thinking…" };
    agent.onPrompt = async (_params, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_thought_chunk",
        content: thought,
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "think about it");

    const unknownEntries = entriesFor(task.taskId).filter(
      (e) => e.type === "unknown",
    );
    expect(unknownEntries).toHaveLength(1);
    expect(unknownEntries[0].text).toBe("agent_thought_chunk");
    expect(unknownEntries[0].raw).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: thought,
    });
  });

  it("routes agent file writes through the platform adapter", async () => {
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

    const tools = toolEntries(task.taskId);
    expect(tools).toHaveLength(1); // one card, not four
    expect(tools[0].toolCall?.status).toBe("completed"); // merged latest state
    expect(tools[0].toolCall?.title).toBe("Write README.md"); // kept from first
  });

  it("merges a failed tool status into the one entry", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
      });
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "test");

    const tools = toolEntries(task.taskId);
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCall?.status).toBe("failed"); // sweep must not override
  });

  it("resolves a tool call left in_progress when the turn ends", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Grep",
        kind: "search",
        status: "in_progress",
      });
      // No completion update — the harness never closes it.
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "find");

    // The turn-end sweep flips the lingering call so it doesn't spin forever.
    expect(toolEntries(task.taskId)[0].toolCall?.status).toBe("completed");
  });

  it("applies a tool_call_update that arrives after the turn ended", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Write README.md",
        kind: "edit",
        status: "in_progress",
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "edit");

    // A late update (no active turn) must still coalesce into the entry.
    task.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        content: [{ type: "diff", path: "/ws/README.md", newText: "# Hi\n" }],
      },
    } as unknown as Parameters<typeof task.handleSessionUpdate>[0]);

    const tools = toolEntries(task.taskId);
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCall?.status).toBe("failed");
    expect(tools[0].toolCall?.content?.[0]).toMatchObject({ type: "diff" });
  });

  it("interleaves text and tool calls in order", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Looking… " },
      });
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        kind: "read",
        status: "completed",
      });
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "go");

    // user, assistant("Looking… "), tool_call, assistant("Done.") — in order.
    const types = entriesFor(task.taskId).map((e) => e.type);
    expect(types).toEqual(["user", "assistant", "tool_call", "assistant"]);
    const texts = entriesFor(task.taskId)
      .filter((e) => e.type === "assistant")
      .map((e) => e.text);
    expect(texts).toEqual(["Looking… ", "Done."]);
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

function interactionsFor(taskId: string) {
  return agentInteractionsCollection.toArray.filter((i) => i.taskId === taskId);
}

describe("prompt handles (A3, Stage 1)", () => {
  it("resolves the handle when the turn completes", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    const handle = task.prompt("hi");
    const outcome = await handle.completed;
    expect(outcome).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it("resolves a displaced prompt as superseded", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    agent.onPrompt = async (params) => {
      if (params.prompt[0].text === "one") await gate;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    const first = task.prompt("one");
    await vi.waitFor(() => expect(turnFor(task.taskId).length).toBe(1));
    const second = task.prompt("two"); // "one" is already running, so "two" queues
    const third = task.prompt("three"); // displaces "two" before it ever runs
    releaseFirst();

    expect(await second.completed).toEqual({ status: "superseded" });
    expect(await first.completed).toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(await third.completed).toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
  });

  it("carries the error message when a turn fails", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    const outcome = await task.prompt("go").completed;
    expect(outcome).toEqual({
      status: "error",
      error: expect.stringMatching(/authentication required/i),
    });
  });
});

describe("interactions (Stage 1)", () => {
  it("raises a source:auth interaction with a real entryId join target on auth failure", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "go");

    const interactions = interactionsFor(task.taskId);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ source: "auth", state: "pending" });

    const entry = agentEntriesCollection.get(interactions[0].entryId);
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("unknown");
  });

  it("composes exactly one continuation prompt from queued tool answers once idle", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    agent.onPrompt = async (params) => {
      seen.push(params.prompt[0].text);
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "start");

    // Simulate two tool-sourced interactions this task raised.
    const entryId = "evt_test";
    agentEntriesCollection.insert({
      id: entryId,
      taskId: task.taskId,
      turnId: turnFor(task.taskId)[0].turnId,
      type: "tool_call",
      createdAt: Date.now(),
    });
    agentInteractionsCollection.insert({
      id: "itx_1",
      taskId: task.taskId,
      entryId,
      source: "tool",
      state: "pending",
      question: "Overwrite the file?",
      createdAt: Date.now(),
    });
    agentInteractionsCollection.insert({
      id: "itx_2",
      taskId: task.taskId,
      entryId,
      source: "tool",
      state: "pending",
      question: "Delete the backup?",
      createdAt: Date.now(),
    });

    task.answerInteraction("itx_1", "yes");
    task.answerInteraction("itx_2", "no");

    await vi.waitFor(() => expect(seen).toEqual(["start", expect.any(String)]));
    expect(seen[1]).toContain("Overwrite the file?");
    expect(seen[1]).toContain("Delete the backup?");

    const rows = interactionsFor(task.taskId).filter((i) => i.source === "tool");
    expect(rows.every((r) => r.state === "answered")).toBe(true);
  });

  it("marks pending interactions cancelled on task cancel", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await runPrompt(task, "go");

    expect(interactionsFor(task.taskId)[0].state).toBe("pending");
    await task.cancel();
    expect(interactionsFor(task.taskId)[0].state).toBe("cancelled");
  });
});
