import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
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
    },
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));
// The mock harness is env-gated by VITE_AGENT_MOCK, which vitest doesn't
// set — flip it so AgentTask.start wires the mock MCP loopback (what lets a
// replayed `mcp` event reach the real tool handler).
vi.mock("@/agent/mock-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/mock-harness")>();
  return { ...actual, MOCK_AGENT_MODE: true };
});

import { TaskManager } from "@/agent/agent-service";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "@/agent/agent-collections";
import {
  configureMockAgent,
  createMockAgentTransport,
  registerMockScenario,
  remapWorkspacePath,
} from "@/agent/mock-harness";
import {
  buildSessionRecording,
  isAgentRecording,
  type AgentRecording,
} from "../debug-panel-recording";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import type { AgentTask } from "@/agent/agent-service";

const harness = BUILT_IN_HARNESSES[0];

function entriesFor(taskId: string) {
  return agentEntriesCollection.toArray
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** What the debug panel does: the task's rows → a recording. */
function recordingFor(taskId: string): AgentRecording {
  return buildSessionRecording({
    task: agentTasksCollection.get(taskId)!,
    turns: agentTurnsCollection.toArray.filter((t) => t.taskId === taskId),
    entries: entriesFor(taskId),
    permissionRequests: agentPermissionRequestsCollection.toArray.filter(
      (r) => r.taskId === taskId,
    ),
  });
}

async function runPrompt(task: AgentTask, text: string): Promise<void> {
  await task.prompt(text).completed;
}

/** What startAgentTask does under MOCK_AGENT_MODE. */
async function startMock(task: AgentTask): Promise<void> {
  await task.start(() => createMockAgentTransport({ taskId: task.taskId }));
}

/** Send a prompt, answer the one permission request it raises the way the
 *  card would, and wait for the turn. */
async function runPromptAnsweringPermission(
  task: AgentTask,
  text: string,
  optionId: string,
): Promise<void> {
  const handle = task.prompt(text);
  const pendingFor = () =>
    agentPermissionRequestsCollection.toArray.find(
      (r) => r.taskId === task.taskId && r.status === "pending",
    );
  await vi.waitFor(() => expect(pendingFor()).toBeDefined());
  task.respondPermission(pendingFor()!.id, {
    outcome: { outcome: "selected", optionId },
  });
  await handle.completed;
}

/** The shape of every recording-relevant entry, minus ids/timestamps. */
function transcriptShape(taskId: string) {
  return entriesFor(taskId).map((e) => ({
    type: e.type,
    text: e.text,
    tool: e.toolCall
      ? {
          title: e.toolCall.title,
          status: e.toolCall.status,
          kind: e.toolCall.kind,
          rawInput: e.toolCall.rawInput,
          content: e.toolCall.content,
        }
      : undefined,
    plan: e.plan,
  }));
}

beforeEach(() => {
  for (const e of agentEntriesCollection.toArray)
    agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray)
    agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray)
    agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
});

/** A turn touching every entry type, streamed in small chunks, with a
 *  plan revised twice and a reject-only permission request. */
registerMockScenario("everything", () => async (ctx) => {
  ctx.emit({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Let me " },
  });
  ctx.emit({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "look." },
  });
  ctx.emit({
    sessionUpdate: "plan",
    entries: [{ content: "Read the file", priority: "high", status: "in_progress" }],
  });
  ctx.emit({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "Read README.md",
    kind: "read",
    status: "pending",
    rawInput: { path: `${ctx.workspacePath}/README.md` },
  });
  ctx.emit({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "# Hi" } }],
  });
  ctx.emit({
    sessionUpdate: "plan",
    entries: [{ content: "Read the file", priority: "high", status: "completed" }],
  });
  await ctx.request("session/request_permission", {
    sessionId: ctx.sessionId,
    toolCall: { toolCallId: "call_2", title: "Delete build/" },
    options: [{ optionId: "no", name: "No", kind: "reject_once" }],
  });
  ctx.emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Done. Echo: ${ctx.promptText}` },
  });
  return { stopReason: "end_turn" };
});

describe("agent recording (derived from the transcript)", () => {
  it("re-shapes a task's rows into the recording format", async () => {
    configureMockAgent({ scenario: "everything" });
    const task = new TaskManager("/ws/original").createTask(harness);
    await startMock(task);
    await runPromptAnsweringPermission(task, "look at the readme", "no");

    const rec = recordingFor(task.taskId);
    expect(isAgentRecording(rec)).toBe(true);
    expect(rec.harnessId).toBe(harness.id);
    expect(rec.workspacePath).toBe("/ws/original");
    expect(rec.sessionId).toMatch(/^mock_session_/);
    expect(rec.turns).toHaveLength(1);
    expect(rec.outOfTurn).toEqual([]);

    const recorded = rec.turns[0];
    expect(recorded.prompt).toEqual([{ type: "text", text: "look at the readme" }]);
    expect(recorded.stopReason).toBe("end_turn");
    const kinds = recorded.events.map((e) =>
      e.kind === "update" ? `update:${e.update.sessionUpdate}` : `${e.kind}:${e.method}`,
    );
    // Permission first (it interrupted the turn); then one event per
    // entry: thought run coalesced, ONE plan (the app keeps the last), the
    // tool call in its final state, the reply.
    expect(kinds).toEqual([
      "request:session/request_permission",
      "update:agent_thought_chunk",
      "update:plan",
      "update:tool_call",
      "update:agent_message_chunk",
    ]);
    // The row records that it was settled, not which option (the broker
    // keeps no optionId) — so the derived reply is a bare "selected".
    const permission = recorded.events[0];
    expect(permission.kind === "request" && permission.params.options).toEqual([
      { optionId: "no", name: "No", kind: "reject_once" },
    ]);
    expect(permission.kind === "request" && permission.response).toEqual({
      outcome: { outcome: "selected" },
    });
    const tool = recorded.events[3];
    expect(tool.kind === "update" && tool.update.status).toBe("completed");
    const ats = recorded.events.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it("replays a derived recording through the real client and reproduces the transcript", async () => {
    configureMockAgent({ scenario: "everything" });
    const original = new TaskManager("/ws/original").createTask(harness);
    await startMock(original);
    await runPromptAnsweringPermission(original, "look at the readme", "no");
    const recording = recordingFor(original.taskId);
    const expected = transcriptShape(original.taskId);

    // A different workspace: the replay must remap recorded paths.
    configureMockAgent({ scenario: "replay", options: { recording } });
    const replayed = new TaskManager("/ws/replayed").createTask(harness);
    await startMock(replayed);
    await runPromptAnsweringPermission(replayed, "look at the readme", "no");

    expect(transcriptShape(replayed.taskId)).toEqual(
      remapWorkspacePath(expected, "/ws/original", "/ws/replayed"),
    );
    const readTool = entriesFor(replayed.taskId).find((e) => e.type === "tool_call");
    expect(readTool?.toolCall?.rawInput).toEqual({ path: "/ws/replayed/README.md" });
    const turn = agentTurnsCollection.toArray.find((t) => t.taskId === replayed.taskId);
    expect(turn?.status).toBe("completed");
    expect(turn?.stopReason).toBe("end_turn");
  });

  it("plays recorded turns in order, then repeats the last", async () => {
    const recording: AgentRecording = {
      format: "notefig-agent-recording",
      version: 1,
      recordedAt: "2026-09-19T00:00:00.000Z",
      harnessId: harness.id,
      taskId: "task_fixture",
      workspacePath: "/ws/x",
      outOfTurn: [],
      turns: ["one", "two"].map((label) => ({
        prompt: [{ type: "text", text: label }],
        startedAt: 0,
        endedAt: 1,
        stopReason: "end_turn",
        events: [
          {
            kind: "update",
            at: 0,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `reply ${label}` },
            },
          },
        ],
      })),
    };
    configureMockAgent({ scenario: "replay", options: { recording } });
    const task = new TaskManager("/ws/y").createTask(harness);
    await startMock(task);
    await runPrompt(task, "a");
    await runPrompt(task, "b");
    await runPrompt(task, "c");
    const replies = entriesFor(task.taskId)
      .filter((e) => e.type === "assistant")
      .map((e) => e.text);
    expect(replies).toEqual(["reply one", "reply two", "reply two"]);
  });

  it("a recorded error ends the replayed turn as an error", async () => {
    const recording: AgentRecording = {
      format: "notefig-agent-recording",
      version: 1,
      recordedAt: "2026-09-19T00:00:00.000Z",
      harnessId: harness.id,
      taskId: "task_fixture",
      workspacePath: "/ws/x",
      outOfTurn: [],
      turns: [
        {
          prompt: [{ type: "text", text: "boom" }],
          startedAt: 0,
          endedAt: 1,
          error: { code: -32000, message: "rate limited" },
          events: [],
        },
      ],
    };
    configureMockAgent({ scenario: "replay", options: { recording } });
    const task = new TaskManager("/ws/y").createTask(harness);
    await startMock(task);
    const outcome = await task.prompt("boom").completed;
    expect(outcome.status).toBe("error");
    expect(outcome.status === "error" && outcome.error).toContain("rate limited");
  });

  it("derives an errored turn and turnless stragglers", () => {
    const rec = buildSessionRecording({
      task: {
        taskId: "t",
        workspacePath: "/ws",
        title: "t",
        status: "error",
        harnessId: harness.id,
        createdAt: 1,
        updatedAt: 1,
      },
      turns: [
        {
          turnId: "trn_1",
          taskId: "t",
          sessionId: "s",
          status: "error",
          error: "overloaded",
          startedAt: 5,
        },
      ],
      entries: [
        { id: "evt_1", taskId: "t", turnId: "trn_1", type: "user", text: "hi" },
        { id: "evt_2", taskId: "t", turnId: "trn_1", type: "assistant", text: "partial" },
        {
          id: "evt_3",
          taskId: "t",
          turnId: "",
          type: "tool_call",
          toolCallId: "x",
          toolCall: { toolCallId: "x", status: "failed" },
        },
      ],
      permissionRequests: [],
    });
    expect(rec.turns[0].error?.message).toBe("overloaded");
    expect(rec.turns[0].stopReason).toBeUndefined();
    expect(rec.turns[0].events.map((e) => e.kind)).toEqual(["update"]);
    expect(rec.outOfTurn).toHaveLength(1);
  });
});
