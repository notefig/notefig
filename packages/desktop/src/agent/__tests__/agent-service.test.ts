import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the platform adapter singleton the file-sync helpers and task service use.
// vi.hoisted so the fns exist before the hoisted vi.mock factory runs.
const { writeFiles, readFiles, deleteFiles, mcpEndpoints } = vi.hoisted(() => ({
  writeFiles: vi.fn(async (files: { path: string; content: string }[]) => ({
    succeeded: files.map((f) => f.path),
    failed: [] as unknown[],
  })),
  readFiles: vi.fn(async (paths: string[]) => ({
    succeeded: paths.map((p) => ({ path: p, content: "old contents\n" })),
    failed: [] as unknown[],
  })),
  deleteFiles: vi.fn(async (paths: string[]) => ({
    succeeded: paths,
    failed: [] as unknown[],
  })),
  // Every McpEndpoint the fake constructs, in order — lets dispose tests
  // assert the endpoint's close() ran.
  mcpEndpoints: [] as { close: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      writeFiles,
      readFiles,
      deleteFiles,
    },
    proc: {
      // A fake McpEndpoint: nothing in these tests drives real traffic over
      // the MCP channel (that's exercised at the tool-call level via
      // FakeAgent's scripted ACP session/update notifications instead), so
      // this just has to satisfy attachMcpEndpoint's onRequest + dispose's
      // close. Dumb sync constructor, matching createAgentTransport's contract
      // — AgentTask.start() calls .start() and reads .mcpServer itself.
      createMcpEndpoint: vi.fn(() => {
        const endpoint = {
          mcpServer: { name: "notefig", command: "notefig", args: [], env: [] },
          start: vi.fn(async () => {}),
          onRequest: vi.fn(() => () => {}),
          close: vi.fn(async () => {}),
        };
        mcpEndpoints.push(endpoint);
        return endpoint;
      }),
    },
  },
}));
// History auto-checkpointing (Stage 2) is exercised separately; keep these
// tests focused on the turn machinery, not git plumbing.
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "../mock-harness";
import {
  TaskManager,
  respondToAgentPermission,
  findBlobAuthorTask,
} from "../agent-service";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTurnsCollection,
  agentTasksCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
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

function lastPromptText(params: { prompt: { text?: string }[] }): string {
  return params.prompt[params.prompt.length - 1].text ?? "";
}

/** Fire a prompt (now fire-and-forget) and wait for its turn to settle. */
async function runPrompt(task: AgentTask, text: string): Promise<void> {
  const before = turnFor(task.taskId).length;
  task.prompt(text);
  await vi.waitFor(() => {
    const turns = turnFor(task.taskId);
    expect(turns.length).toBe(before + 1);
    expect(["completed", "error", "cancelled"]).toContain(
      turns[turns.length - 1].status,
    );
  });
}

beforeEach(() => {
  writeFiles.mockClear();
  readFiles.mockClear();
  deleteFiles.mockClear();
  mcpEndpoints.length = 0;
  for (const e of agentEntriesCollection.toArray)
    agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray)
    agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray)
    agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
});

afterEach(() => {
  vi.useRealTimers();
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
    await task.start(() => client);
    await runPrompt(task, "hi");

    expect(textFor(task.taskId, "user")).toBe("hi");
    expect(textFor(task.taskId, "assistant")).toContain("Hello world");
    expect(turnFor(task.taskId)[0].status).toBe("completed");
    expect(turnFor(task.taskId)[0].stopReason).toBe("end_turn");
  });

  it("records unknown session updates as a catch-all entry (D4)", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const commands = {
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    };
    agent.onPrompt = async (_params, a) => {
      a.update("sess_test", commands);
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "hello");

    const unknownEntries = entriesFor(task.taskId).filter(
      (e) => e.type === "unknown",
    );
    expect(unknownEntries).toHaveLength(1);
    expect(unknownEntries[0].text).toBe("available_commands_update");
    expect(unknownEntries[0].raw).toEqual(commands);
  });

  it("coalesces token-streamed thought chunks into one entry per contiguous run", async () => {
    // Mirrors the real OpenCode transcript shape: a thought streamed as many
    // tiny chunks, a tool call, another thought, then the visible reply —
    // must land as exactly [user, thought, tool_call, thought, assistant].
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const think = (a: FakeAgent, text: string) =>
      a.update("sess_test", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      });
    agent.onPrompt = async (_params, a) => {
      think(a, "The user ");
      think(a, "is asking ");
      think(a, "about the workspace.");
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "ls",
        kind: "read",
        status: "completed",
      });
      think(a, "Looks like ");
      think(a, "Dante's Inferno.");
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "This is the Inferno workspace." },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "hi what harness is this?");

    const entries = entriesFor(task.taskId);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "thought",
      "tool_call",
      "thought",
      "assistant",
    ]);
    const thoughts = entries
      .filter((e) => e.type === "thought")
      .map((e) => e.text);
    expect(thoughts).toEqual([
      "The user is asking about the workspace.",
      "Looks like Dante's Inferno.",
    ]);
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
    await task.start(() => client);
    await runPrompt(task, "edit the readme");

    expect(writeFiles).toHaveBeenCalledWith([
      { path: "/ws/README.md", content: "# New title\n" },
    ]);
  });

  it("auto-approves any permission request that offers an allow option (beta blanket grant)", async () => {
    // Deliberate product decision (acp-client.requestPermission): the beta
    // runs fully silent, preferring allow_always so the harness stops
    // re-asking. Nothing surfaces to the UI.
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
    await task.start(() => client);
    await runPrompt(task, "edit");

    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(pendingPerms(task.taskId)).toHaveLength(0);
  });

  it("publishes a reject-only permission request and settles it via the collection", async () => {
    // Only requests with NO allow option reach the broker/UI now — the
    // blanket grant answers everything else (see acp-client.requestPermission).
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let outcome: unknown;
    agent.onPrompt = async (_params, a) => {
      const response = await a.request("session/request_permission", {
        sessionId: "sess_test",
        toolCall: { toolCallId: "call_1", title: "Write README.md" },
        options: [
          { optionId: "deny", name: "Deny", kind: "reject_once" },
          {
            optionId: "deny_always",
            name: "Always Deny",
            kind: "reject_always",
          },
        ],
      });
      outcome = response.outcome;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("edit");

    await vi.waitFor(() => expect(pendingPerms(task.taskId).length).toBe(1));
    const head = pendingPerms(task.taskId)[0];
    respondToAgentPermission(task.taskId, head.id, {
      outcome: { outcome: "selected", optionId: "deny" },
    });

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("completed"),
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "deny" });
    // Row left the pending set.
    expect(pendingPerms(task.taskId)).toHaveLength(0);
  });

  it("auto-approves permission requests for our own mcp__notefig__* tools, no UI prompt", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let outcome: unknown;
    agent.onPrompt = async (_params, a) => {
      const response = await a.request("session/request_permission", {
        sessionId: "sess_test",
        toolCall: { toolCallId: "call_1", title: "mcp__notefig__author_blob" },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          {
            optionId: "allow_always",
            name: "Always Allow",
            kind: "allow_always",
          },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      outcome = response.outcome;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "add a question");

    // Granted immediately — never surfaced as a row to answer.
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow_always" });
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
        // Reject-only, so it surfaces to the UI instead of auto-granting.
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      });
      outcome = response.outcome;
      return { stopReason: "cancelled" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("do it");

    await vi.waitFor(() => expect(pendingPerms(task.taskId).length).toBe(1));
    await task.cancel();

    await vi.waitFor(() => expect(outcome).toEqual({ outcome: "cancelled" }));
  });

  it("cancelAndForgetTurn deletes a response-less round's rows, earlier rounds stay (MET-94)", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => (releaseSecond = r));
    let promptCount = 0;
    agent.onPrompt = async () => {
      if (promptCount++ === 0) return { stopReason: "end_turn" };
      // No output before the gate — the user escapes before any response.
      await secondGate;
      return { stopReason: "cancelled" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "keep me");
    const keptEntries = entriesFor(task.taskId).length;

    task.prompt("doomed prompt");
    await vi.waitFor(() =>
      expect(entriesFor(task.taskId).length).toBeGreaterThan(keptEntries),
    );

    await expect(task.cancelAndForgetTurn()).resolves.toBe(true);
    releaseSecond();

    // The aborted round vanished — turn row and entries alike — while the
    // completed first round is untouched.
    expect(turnFor(task.taskId)).toHaveLength(1);
    expect(turnFor(task.taskId)[0].status).toBe("completed");
    expect(entriesFor(task.taskId)).toHaveLength(keptEntries);
    expect(textFor(task.taskId, "user")).toBe("keep me");
  });

  it("cancelAndForgetTurn keeps the round once the agent has responded (MET-94)", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    agent.onPrompt = async (_params, a) => {
      a.update("sess_test", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial output" },
      });
      await gate;
      return { stopReason: "cancelled" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("interrupted late");
    await vi.waitFor(() =>
      expect(textFor(task.taskId, "assistant")).toBe("partial output"),
    );

    // A response exists — forgetting would hide context the session still
    // holds, so the round stays as a plain cancelled turn.
    await expect(task.cancelAndForgetTurn()).resolves.toBe(false);
    release();

    expect(turnFor(task.taskId)).toHaveLength(1);
    expect(turnFor(task.taskId)[0].status).toBe("cancelled");
    expect(textFor(task.taskId, "user")).toBe("interrupted late");
    expect(textFor(task.taskId, "assistant")).toBe("partial output");
  });

  it("queues prompts sent during a running turn FIFO — none dropped", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let promptCount = 0;
    agent.onPrompt = async (params, _a) => {
      seen.push(lastPromptText(params));
      if (promptCount++ === 0) await firstGate; // hold the first turn open
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    task.prompt("first"); // starts a turn, gated open
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    task.prompt("second");
    task.prompt("third");
    task.prompt("fourth");
    expect(seen).toEqual(["first"]); // nothing new delivered yet
    releaseFirst();

    await vi.waitFor(() =>
      expect(seen).toEqual(["first", "second", "third", "fourth"]),
    );
  });

  it("prompt({ front: true }) jumps ahead of already-queued prompts", async () => {
    // `front` means "ahead of everything queued, behind whatever is already
    // running" — the running turn was shifted out synchronously when it was
    // sent, so front-insert lands between it and the rest of the queue.
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    agent.onPrompt = async (params) => {
      const text = lastPromptText(params);
      if (text === "first") await gate; // hold the running turn open
      seen.push(text);
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const firstDone = task.prompt("first").completed; // starts running immediately
    const secondDone = task.prompt("second").completed; // queues behind it
    const thirdDone = task.prompt("third", { front: true }).completed; // jumps "second"

    release();
    await Promise.all([firstDone, secondDone, thirdDone]);

    expect(seen).toEqual(["first", "third", "second"]);
  });

  it("renders queued prompts as transcript rows and promotes the same rows to running", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let promptCount = 0;
    agent.onPrompt = async () => {
      if (promptCount++ === 0) await firstGate;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("one");
    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    const queuedHandle = task.prompt("two");

    // Entry + turn row exist immediately, with status "queued".
    const queuedRow = agentTurnsCollection.get(queuedHandle.turnId);
    expect(queuedRow?.status).toBe("queued");
    const userEntries = entriesFor(task.taskId).filter(
      (e) => e.type === "user" && e.turnId === queuedHandle.turnId,
    );
    expect(userEntries).toHaveLength(1);

    releaseFirst();
    await queuedHandle.completed;

    // Promotion reused the same rows (ids stable, no duplicates).
    expect(agentTurnsCollection.get(queuedHandle.turnId)?.status).toBe(
      "completed",
    );
    expect(
      entriesFor(task.taskId).filter(
        (e) => e.type === "user" && e.turnId === queuedHandle.turnId,
      ),
    ).toHaveLength(1);
  });

  it("cancel() resolves queued prompts cancelled and flips their rows", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = () => new Promise(() => {}); // hold the turn open forever

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("running");
    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    const q1 = task.prompt("queued 1");
    const q2 = task.prompt("queued 2");

    await task.cancel();

    expect(await q1.completed).toEqual({ status: "cancelled" });
    expect(await q2.completed).toEqual({ status: "cancelled" });
    expect(agentTurnsCollection.get(q1.turnId)?.status).toBe("cancelled");
    expect(agentTurnsCollection.get(q2.turnId)?.status).toBe("cancelled");
  });

  it("removeQueuedPrompt removes exactly one queued prompt and its rows", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let promptCount = 0;
    agent.onPrompt = async (params) => {
      seen.push(lastPromptText(params));
      if (promptCount++ === 0) await firstGate;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("one");
    await vi.waitFor(() => expect(seen).toEqual(["one"]));
    const removed = task.prompt("two");
    const kept = task.prompt("three");

    task.removeQueuedPrompt(removed.turnId);

    expect(await removed.completed).toEqual({ status: "cancelled" });
    expect(agentTurnsCollection.get(removed.turnId)).toBeUndefined();
    expect(
      entriesFor(task.taskId).filter((e) => e.turnId === removed.turnId),
    ).toHaveLength(0);
    // The other queued prompt is untouched and still runs.
    releaseFirst();
    await kept.completed;
    expect(seen).toEqual(["one", "three"]);
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
    await taskA.start(() => clientA);
    await taskB.start(() => clientB);
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
    await task.start(() => client);
    task.prompt("hang");

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    await client.close(); // simulate crash

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("error"),
    );
  });

  it("marks the task errored when the transport closes while idle", async () => {
    // The idle-close branch of handleTransportClose: no turn is running, so
    // there's nothing to fail — the task itself flips to error.
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "hi"); // task settles to idle
    expect(task.currentStatus).toBe("idle");

    await client.close(); // transport drops with no turn running

    expect(task.currentStatus).toBe("error");
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
    await task.start(() => client);
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
    await task.start(() => client);
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
    await task.start(() => client);
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
    await task.start(() => client);
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

  it("applies a terminal update carrying adapter-shaped rawOutput mid-turn", async () => {
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
      // claude-agent-acp attaches the raw Anthropic tool_result content — an
      // array (or bare string) — which agent-client-protocol 0.4.5's schema
      // rejects, silently dropping the whole frame. sanitizeAcpFrame must
      // keep it valid or the tool shimmers until turn end (MET-104).
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: [{ type: "text", text: "ok" }],
      });
      // Hold the turn open until the status lands: the turn-end sweep would
      // otherwise complete the call itself and mask a dropped frame.
      await vi.waitFor(() =>
        expect(toolEntries(task.taskId)[0]?.toolCall?.status).toBe("completed"),
      );
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "test");

    // The boxed shape the sanitizer wraps non-object payloads into.
    expect(toolEntries(task.taskId)[0].toolCall?.rawOutput).toEqual({
      output: [{ type: "text", text: "ok" }],
    });
  });

  it("sweeps turnless straggler tool calls at the next turn end", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "one");

    // A brand-new tool_call with no turn to attach to (adapter straggler
    // after the turn boundary) inserts with turnId "" — the sweep must
    // still close it or it spins forever (MET-104).
    task.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t9",
        title: "Straggler",
        kind: "execute",
        status: "in_progress",
      },
    } as unknown as Parameters<typeof task.handleSessionUpdate>[0]);

    await runPrompt(task, "two");

    const straggler = toolEntries(task.taskId).find(
      (entry) => entry.toolCallId === "t9",
    );
    expect(straggler?.toolCall?.status).toBe("completed");
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
    await task.start(() => client);
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
    await task.start(() => client);
    await runPrompt(task, "go");

    const turn = turnFor(task.taskId)[0];
    expect(turn.status).toBe("error");
    expect(turn.error).toMatch(/authentication required/i);
  });

  it("halts the drain on an error turn; the rest of the queue stays queued", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    agent.onPrompt = async (params) => {
      seen.push(lastPromptText(params));
      await gate; // hold the first turn open so a second can be queued
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    task.prompt("one");
    await vi.waitFor(() => expect(seen).toEqual(["one"]));
    const queued = task.prompt("two"); // queues while the (failing) first runs
    releaseFirst();

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("error"),
    );
    // The drain halted on the error; "two" was not run and stays visibly queued.
    expect(seen).toEqual(["one"]);
    expect(agentTurnsCollection.get(queued.turnId)?.status).toBe("queued");
  });

  it("prompt() on a never-started task resolves an error value, never throws", async () => {
    const task = new TaskManager("/ws").createTask(harness);

    const handle = task.prompt("hello");
    expect(await handle.completed).toEqual({
      status: "error",
      error: expect.stringMatching(/not started/i),
    });
    expect(agentTurnsCollection.get(handle.turnId)?.status).toBe("error");
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
    await task.start(() => client);
    await runPrompt(task, "go");

    expect(turnFor(task.taskId)[0].status).toBe("completed");
    // The thought chunk is not rendered, so no assistant message is created.
    expect(textFor(task.taskId, "assistant")).toBe("");
  });
});

describe("prompt handles (A3, Stage 1)", () => {
  it("resolves the handle when the turn completes", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const handle = task.prompt("hi");
    const outcome = await handle.completed;
    expect(outcome).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it("resolves every queued prompt's handle — nothing is displaced", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    agent.onPrompt = async (params) => {
      if (lastPromptText(params) === "one") await gate;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const first = task.prompt("one");
    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    const second = task.prompt("two"); // "one" is already running, so "two" queues
    const third = task.prompt("three"); // …and "three" queues behind it
    releaseFirst();

    expect(await first.completed).toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(await second.completed).toEqual({
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
    await task.start(() => client);

    const outcome = await task.prompt("go").completed;
    expect(outcome).toEqual({
      status: "error",
      error: expect.stringMatching(/authentication required/i),
    });
  });
});

describe("MCP tool calls (Stage 3.5)", () => {
  it("normalizes an mcp__notefig__* tool name and derives locations from rawInput.path", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "mcp__notefig__author_blob",
        kind: "other",
        status: "pending",
        rawInput: {},
      });
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawInput: { path: "notes.md", type: "question", id: "question_8f2a" },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "ask a question");

    const tools = toolEntries(task.taskId);
    expect(tools).toHaveLength(1); // still one coalesced card, not two
    expect(tools[0].toolCall?.title).toBe("author_blob"); // prefix stripped
    expect(tools[0].toolCall?.status).toBe("completed");
    expect(tools[0].toolCall?.locations).toEqual([{ path: "/ws/notes.md" }]);
  });

  it("keeps previously-derived locations when a later update carries no rawInput.path", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "mcp__notefig__history_restore",
        kind: "edit",
        status: "pending",
        rawInput: { path: "notes.md", checkpoint: "abc123" },
      });
      // A bare status flip with no rawInput at all — must not regress locations.
      a.update("sess_test", {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "restore");

    const tools = toolEntries(task.taskId);
    expect(tools[0].toolCall?.locations).toEqual([{ path: "/ws/notes.md" }]);
    expect(tools[0].toolCall?.status).toBe("completed");
  });

  it("findBlobAuthorTask resolves a known blobId from the normalized author_blob call", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "mcp__notefig__author_blob",
        kind: "other",
        status: "completed",
        rawInput: { path: "notes.md", type: "question", id: "question_8f2a" },
      });
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "ask a question");

    expect(findBlobAuthorTask("question_8f2a")).toEqual({
      taskId: task.taskId,
      blobType: "question",
      path: "notes.md",
    });
    expect(findBlobAuthorTask("does_not_exist")).toBeUndefined();
  });
});

describe("Stage 4: auth flows", () => {
  const authMethods = [
    {
      id: "claude-login",
      name: "Log in with Claude",
      description: "Run `claude /login` in the terminal",
    },
  ];

  function authScriptedPair(failures: number) {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.initializeResult = {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods,
    };
    const seen: string[] = [];
    let remainingFailures = failures;
    agent.onPrompt = async (params) => {
      seen.push(lastPromptText(params as { prompt: { text?: string }[] }));
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Authentication required");
      }
      return { stopReason: "end_turn" };
    };
    return { client, agent, seen };
  }

  it("an auth-failed turn puts authRequired + methods on the task row", async () => {
    const { client } = authScriptedPair(1);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go");

    const row = agentTasksCollection.get(task.taskId)!;
    expect(row.authRequired).toBe(true);
    expect(row.authMethods).toEqual(authMethods);
    expect(row.authHint).toBe("Run `claude /login` in the terminal");
  });

  it("authenticate() success retries the held prompt exactly once and clears the block", async () => {
    const { client, seen } = authScriptedPair(1);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go");

    const result = await task.authenticate("claude-login");
    expect(result).toEqual({ ok: true });

    await vi.waitFor(() => {
      const turns = turnFor(task.taskId);
      expect(turns[turns.length - 1].status).toBe("completed");
    });
    expect(seen).toEqual(["go", "go"]);
    expect(agentTasksCollection.get(task.taskId)?.authRequired).toBe(false);
  });

  it("authenticate() failure is a value; the block stays and nothing retries", async () => {
    const { client, agent, seen } = authScriptedPair(99);
    agent.onAuthenticate = async () => {
      throw new Error("method is out-of-band");
    };
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go");

    const result = await task.authenticate("claude-login");
    expect(result.ok).toBe(false);
    expect(seen).toEqual(["go"]);
    expect(agentTasksCollection.get(task.taskId)?.authRequired).toBe(true);
  });

  it("retryHeldPrompt() runs the held prompt before prompts queued behind the block", async () => {
    const { client, seen } = authScriptedPair(1);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "one"); // fails with the auth block, held
    task.prompt("two"); // stays queued behind the halted drain

    task.retryHeldPrompt();
    await vi.waitFor(() => {
      expect(seen).toEqual(["one", "one", "two"]);
    });
    expect(agentTasksCollection.get(task.taskId)?.authRequired).toBe(false);
  });

  it("auth retry reuses the original transcript rows — no duplicate user entry or turn", async () => {
    const { client } = authScriptedPair(1);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go");

    // The failed attempt left exactly one user entry + one errored turn.
    expect(
      entriesFor(task.taskId).filter((e) => e.type === "user"),
    ).toHaveLength(1);
    expect(turnFor(task.taskId)).toHaveLength(1);
    expect(turnFor(task.taskId)[0].status).toBe("error");

    task.retryHeldPrompt();
    await vi.waitFor(() => {
      expect(turnFor(task.taskId)[0].status).toBe("completed");
    });

    // Same rows, promoted — not re-inserted duplicates.
    const userEntries = entriesFor(task.taskId).filter(
      (e) => e.type === "user",
    );
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].text).toBe("go");
    const turns = turnFor(task.taskId);
    expect(turns).toHaveLength(1);
    expect(turns[0].error).toBeUndefined();
  });

  it("auth retry preserves the held prompt's context parts", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.initializeResult = {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods,
    };
    const prompts: unknown[][] = [];
    let failed = false;
    agent.onPrompt = async (params) => {
      prompts.push((params as { prompt: unknown[] }).prompt);
      if (!failed) {
        failed = true;
        throw new Error("Authentication required");
      }
      return { stopReason: "end_turn" };
    };
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    task.prompt("go", {
      contextParts: [{ kind: "resource_link", path: "/ws/doc.md" }],
    });
    await vi.waitFor(() => {
      expect(turnFor(task.taskId)[0]?.status).toBe("error");
    });

    task.retryHeldPrompt();
    await vi.waitFor(() => {
      expect(turnFor(task.taskId)[0].status).toBe("completed");
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContainEqual({
      type: "resource_link",
      uri: "/ws/doc.md",
      name: "/ws/doc.md",
    });
  });

  it("a dismissed sign-in leaves the queue halted — no retry loop (A5 regression)", async () => {
    const { client, seen } = authScriptedPair(99);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go");

    // No authenticate, no retry: exactly one attempt was made.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(["go"]);
  });

  it("re-arms the block when the retried prompt fails auth again", async () => {
    const { client, seen } = authScriptedPair(2); // fails twice, then would pass
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "go"); // attempt 1 → auth block armed
    expect(seen).toEqual(["go"]);
    expect(agentTasksCollection.get(task.taskId)?.authRequired).toBe(true);

    const result = await task.authenticate("claude-login");
    expect(result).toEqual({ ok: true }); // the login call itself succeeded

    // …but the retried prompt hit the same wall — the block re-arms rather
    // than clearing, so the user is asked to sign in again.
    await vi.waitFor(() => {
      expect(seen).toEqual(["go", "go"]);
      expect(agentTasksCollection.get(task.taskId)?.authRequired).toBe(true);
    });
  });
});

describe("task updatedAt (last-activity ordering, MET-48)", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function startedTask(manager: TaskManager) {
    const task = manager.createTask(harness);
    const [client, agentSide] = createLoopbackPair();
    new FakeAgent(agentSide);
    await task.start(() => client);
    return task;
  }

  it("insertTaskRow stamps updatedAt", async () => {
    const task = await startedTask(new TaskManager("/ws"));
    const row = agentTasksCollection.get(task.taskId)!;
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
  });

  it("prompt enqueue bumps updatedAt even when status doesn't change", async () => {
    // An auth block halts the drain, so a new prompt queues without any
    // status transition — the enqueue bump is the only write.
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    await runPrompt(task, "one");

    const before = agentTasksCollection.get(task.taskId)!;
    await sleep(10);
    task.prompt("two");
    const after = agentTasksCollection.get(task.taskId)!;
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after.status).toBe(before.status);
  });

  it("prompting an older task lifts its updatedAt past a newer idle task", async () => {
    const manager = new TaskManager("/ws");
    const older = await startedTask(manager);
    const newer = await startedTask(manager);
    await sleep(10);

    await runPrompt(older, "go");
    const olderRow = agentTasksCollection.get(older.taskId)!;
    const newerRow = agentTasksCollection.get(newer.taskId)!;
    expect(olderRow.updatedAt).toBeGreaterThan(newerRow.updatedAt);
  });
});

describe("Stage 4: per-harness MCP registration", () => {
  const opencodeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "opencode")!;
  const geminiHarness = BUILT_IN_HARNESSES.find((h) => h.id === "gemini-cli")!;

  it('"session-new" harnesses get the server through session/new.mcpServers', async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const task = new TaskManager("/ws").createTask(harness); // claude-code
    await task.start(() => client);

    expect(agent.newSessionParams?.mcpServers).toHaveLength(1);
    expect(agent.newSessionParams?.mcpServers?.[0]?.name).toBe("notefig");
  });

  it('"opencode-config" harnesses get a per-task config file + OPENCODE_CONFIG, and empty mcpServers', async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let capturedEnv: Record<string, string> | undefined;
    const task = new TaskManager("/ws").createTask(opencodeHarness);
    await task.start(({ extraEnv }) => {
      capturedEnv = extraEnv;
      return client;
    });

    const expectedPath = `/ws/.metrists/agent/opencode-${task.taskId}.json`;
    expect(capturedEnv?.OPENCODE_CONFIG).toBe(expectedPath);
    const write = writeFiles.mock.calls
      .flat(1)
      .flat(1)
      .find((f: { path?: string }) => f?.path === expectedPath) as
      | { path: string; content: string }
      | undefined;
    expect(write).toBeDefined();
    const config = JSON.parse(write!.content);
    expect(config.mcp.notefig.type).toBe("local");
    expect(config.mcp.notefig.command).toEqual(["notefig"]);
    expect(agent.newSessionParams?.mcpServers).toEqual([]);
  });

  it('"none" harnesses get neither', async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let capturedEnv: Record<string, string> | undefined;
    const task = new TaskManager("/ws").createTask(geminiHarness);
    await task.start(({ extraEnv }) => {
      capturedEnv = extraEnv;
      return client;
    });

    expect(capturedEnv).toEqual({});
    expect(agent.newSessionParams?.mcpServers).toEqual([]);
  });

  it("normalizes OpenCode's `<server>_<tool>` names like claude's `mcp__` prefix", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async (_p, a) => {
      a.update("sess_test", {
        sessionUpdate: "tool_call",
        toolCallId: "oc_1",
        title: "notefig_author_blob",
        kind: "other",
        status: "completed",
        rawInput: { path: "notes.md", type: "question", id: "question_oc01" },
      });
      return { stopReason: "end_turn" };
    };
    const task = new TaskManager("/ws").createTask(opencodeHarness);
    await task.start(() => client);
    await runPrompt(task, "ask");

    expect(toolEntries(task.taskId)[0].toolCall?.title).toBe("author_blob");
    expect(findBlobAuthorTask("question_oc01")?.taskId).toBe(task.taskId);
  });
});

describe("AgentTask startup timeout (MET-72)", () => {
  const STARTUP_STEP_TIMEOUT_MS = 60_000; // mirrors the module-private constant

  it("a timed-out session/load lands the row on error (not unavailable) and tears down", async () => {
    vi.useFakeTimers();
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onLoadSession = () => new Promise<never>(() => {}); // hang forever

    const task = new TaskManager("/ws").createTask(harness);
    const startPromise = task
      .start(() => client, { resumeSessionId: "sess_old" })
      .catch((e) => e as Error);

    await vi.advanceTimersByTimeAsync(STARTUP_STEP_TIMEOUT_MS + 10);
    const result = await startPromise;

    expect(result).toBeInstanceOf(Error);
    // A *timed-out* revival is a plain error — distinct from the "unavailable"
    // verdict a REJECTED (evicted-session) load produces.
    expect(task.currentStatus).toBe("error");
    expect(mcpEndpoints.at(-1)!.close).toHaveBeenCalled(); // teardown ran
  });
});

describe("AgentTask dispose (MET-72)", () => {
  const opencodeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "opencode")!;

  it("closes the transport and the MCP endpoint", async () => {
    const [client, agentSide] = createLoopbackPair();
    new FakeAgent(agentSide);
    const closeSpy = vi.spyOn(client, "close");
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    await task.dispose();

    expect(closeSpy).toHaveBeenCalled();
    expect(mcpEndpoints.at(-1)!.close).toHaveBeenCalled();
  });

  it("deletes the per-task opencode config it wrote", async () => {
    const [client, agentSide] = createLoopbackPair();
    new FakeAgent(agentSide);
    const task = new TaskManager("/ws").createTask(opencodeHarness);
    await task.start(() => client);
    expect(writeFiles).toHaveBeenCalled(); // config written on start

    await task.dispose();

    expect(deleteFiles).toHaveBeenCalledWith([
      expect.stringContaining(`opencode-${task.taskId}.json`),
    ]);
  });
});
