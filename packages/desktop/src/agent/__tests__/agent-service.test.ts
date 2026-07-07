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
import { TaskManager } from "../agent-service";
import {
  agentDiagnosticsCollection,
  agentEventsCollection,
  agentMessagesCollection,
  agentTurnsCollection,
  agentTasksCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";

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
  return agentTurnsCollection.toArray.filter((t) => t.taskId === taskId);
}

function firstPending(task: { permissionBroker: import("../permission-broker").PermissionBroker }) {
  let head: { id: string } | undefined;
  const unsub = task.permissionBroker.subscribe((list) => {
    head = list[0];
  });
  unsub();
  return head;
}

beforeEach(() => {
  writeFiles.mockClear();
  readFiles.mockClear();
  for (const e of agentEventsCollection.toArray) agentEventsCollection.delete(e.id);
  for (const m of agentMessagesCollection.toArray) agentMessagesCollection.delete(m.messageId);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const d of agentDiagnosticsCollection.toArray)
    agentDiagnosticsCollection.delete(d.id);
});

function diagnostics(taskId: string, kind?: string) {
  return agentDiagnosticsCollection.toArray.filter(
    (d) => d.taskId === taskId && (kind === undefined || d.kind === kind),
  );
}

function toolEvents(taskId: string) {
  return agentEventsCollection.toArray.filter(
    (e) =>
      e.taskId === taskId &&
      (e.kind === "tool_call" || e.kind === "tool_call_update"),
  );
}

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
    await task.prompt("hi");

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
    await task.prompt("edit the readme");

    expect(writeFiles).toHaveBeenCalledWith([
      { path: "/ws/README.md", content: "# New title\n" },
    ]);
  });

  it("resolves a granted permission and settles the agent request", async () => {
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
    const promptDone = task.prompt("edit");

    await vi.waitFor(() => expect(firstPending(task)).toBeTruthy());
    const head = firstPending(task)!;
    task.permissionBroker.respond(head.id, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    await promptDone;
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
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
    const promptDone = task.prompt("do it");

    await vi.waitFor(() => expect(firstPending(task)).toBeTruthy());
    await task.cancel();
    await promptDone;

    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("queues a prompt sent during a running turn and promotes it once", async () => {
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

    const first = task.prompt("first"); // starts a turn, gated open
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    // prompt() now resolves on the prompt's OWN turn completion (A3), so hold
    // the promise rather than awaiting it here (that would deadlock).
    const second = task.prompt("second"); // queued behind the running turn
    expect(seen).toEqual(["first"]); // not delivered yet
    releaseFirst();
    await Promise.all([first, second]);
    expect(seen).toEqual(["first", "second"]); // promoted exactly once, in order
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
    await Promise.all([taskA.prompt("a"), taskB.prompt("b")]);

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
    void task.prompt("hang").catch(() => {});

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("running"),
    );
    await client.close(); // simulate crash

    await vi.waitFor(() =>
      expect(turnFor(task.taskId)[0]?.status).toBe("error"),
    );
  });

  // ===== review fixes =====

  it("A2: coalesces a tool call's updates into one row by toolCallId", async () => {
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
    await task.prompt("edit");

    const tools = toolEvents(task.taskId);
    expect(tools).toHaveLength(1); // one card, not four
    const payload = tools[0].payload as { status?: string; title?: string };
    expect(payload.status).toBe("completed"); // merged latest state
    expect(payload.title).toBe("Write README.md"); // kept from first update
  });

  it("A1/D3: stores the turn failure message and records diagnostics", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => {
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await task.prompt("go");

    const turn = turnFor(task.taskId)[0];
    expect(turn.status).toBe("error");
    expect(turn.error).toMatch(/authentication required/i);
    expect(diagnostics(task.taskId, "turn_error").length).toBeGreaterThan(0);
  });

  it("D2: captures raw frames in both directions", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await task.prompt("hello");

    expect(diagnostics(task.taskId, "frame_out").length).toBeGreaterThan(0);
    expect(diagnostics(task.taskId, "frame_in").length).toBeGreaterThan(0);
    // The outgoing initialize request should be visible as a raw frame.
    expect(
      diagnostics(task.taskId, "frame_out").some((d) =>
        String(d.payload).includes("initialize"),
      ),
    ).toBe(true);
  });

  it("D4: records unrendered session updates instead of dropping them", async () => {
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
    await task.prompt("go");

    const captured = diagnostics(task.taskId, "session_update");
    expect(
      captured.some(
        (d) =>
          (d.payload as { sessionUpdate?: string }).sessionUpdate ===
          "agent_thought_chunk",
      ),
    ).toBe(true);
  });

  it("A5: halts the queue drain after a turn errors", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const seen: string[] = [];
    agent.onPrompt = async (params) => {
      seen.push(params.prompt[0].text);
      throw new Error("Authentication required");
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    const first = task.prompt("one");
    const second = task.prompt("two"); // queued behind the (failing) first
    await first;

    // The drain halted on the first error; the second stayed queued.
    expect(seen).toEqual(["one"]);
    void second; // still pending (would resume on the next prompt)
  });

  it("A3: each prompt resolves on its own turn completion", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    const completed: string[] = [];
    agent.onPrompt = async (params) => {
      await new Promise((r) => setTimeout(r, 5));
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    await task.prompt("a").then(() => completed.push("a"));
    await task.prompt("b").then(() => completed.push("b"));
    expect(completed).toEqual(["a", "b"]);
  });
});
