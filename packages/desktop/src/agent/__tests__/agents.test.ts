import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      writeFiles,
      readFiles,
    },
    proc: {
      createMcpEndpoint: vi.fn(() => ({
        mcpServer: { name: "notefig", command: "notefig", args: [], env: [] },
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

import { createLoopbackPair, decodeWidgetContextUri } from "@notefig/agent";
import { FakeAgent } from "../mock-harness";
import { TaskManager } from "../agent-service";
import { agents, splitLeadingQuote } from "../agents";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

const harness = BUILT_IN_HARNESSES[0];

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

describe("agents facade (Stage 1)", () => {
  it("task(id) actions fail as values for an unknown/disposed task", async () => {
    const handle = agents.task("task_does_not_exist");
    // prompt() is infallible: a missing task returns a handle whose
    // `completed` is already resolved as an error — it never throws.
    const promptHandle = handle.prompt("hi");
    expect(promptHandle.turnId).toEqual(expect.any(String));
    expect(await promptHandle.completed).toEqual({
      status: "error",
      error: expect.any(String),
    });
    expect(await handle.cancel()).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(
      handle.respondPermission("req_1", { outcome: { outcome: "cancelled" } }),
    ).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await handle.setConfigOption("mode", "plan")).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it("task(id).prompt() drives the same underlying AgentTask as the raw class", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const handle = agents.task(task.taskId);
    const outcome = await handle.prompt("hello").completed;
    expect(outcome).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it("task(id).prompt() forwards options (contextParts) unchanged to the underlying AgentTask", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let promptParams: unknown;
    agent.onPrompt = async (params) => {
      promptParams = params;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const handle = agents.task(task.taskId);
    await handle.prompt("hello", {
      contextParts: [
        { kind: "resource_link", path: "notefig://widget-context/abc123" },
      ],
    }).completed;

    const prompt = (
      promptParams as { prompt: Array<{ type: string; uri?: string }> }
    ).prompt;
    expect(prompt).toEqual(
      expect.arrayContaining([
        { type: "text", text: "hello" },
        {
          type: "resource_link",
          uri: "notefig://widget-context/abc123",
          name: "notefig://widget-context/abc123",
        },
      ]),
    );
  });

  it("task(id).promptFromWidget() sends a resource_link (no framing prose) for a non-empty doc", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let promptParams: unknown;
    agent.onPrompt = async (params) => {
      promptParams = params;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const handle = agents.task(task.taskId);
    await handle.promptFromWidget("expand this section", {
      path: "notes.md",
      pos: 42,
      isDocEmpty: false,
    }).completed;

    const prompt = (
      promptParams as {
        prompt: Array<{ type: string; text?: string; uri?: string }>;
      }
    ).prompt;
    expect(prompt[0]).toEqual({ type: "text", text: "expand this section" });
    const resourceLink = prompt.find((b) => b.type === "resource_link");
    expect(resourceLink?.uri).toContain("notefig://widget-context?");
    expect(resourceLink?.uri).toContain("path=notes.md");
    expect(resourceLink?.uri).toContain("pos=42");
  });

  it("task(id).promptFromWidget() quotes a captured reference and carries its range in the URI", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let promptParams: unknown;
    agent.onPrompt = async (params) => {
      promptParams = params;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    await agents.task(task.taskId).promptFromWidget("shorten this", {
      path: "notes.md",
      pos: 42,
      isDocEmpty: false,
      reference: { text: "first line\nsecond line", from: 3, to: 25 },
    }).completed;

    const prompt = (
      promptParams as {
        prompt: Array<{ type: string; text?: string; uri?: string }>;
      }
    ).prompt;
    // The referenced passage leads the prompt as a markdown blockquote.
    expect(prompt[0]).toEqual({
      type: "text",
      text: "> first line\n> second line\n\nshorten this",
    });
    // The URI carries only the capture-time range, never the text.
    const resourceLink = prompt.find((b) => b.type === "resource_link");
    expect(resourceLink?.uri).not.toContain("first");
    expect(decodeWidgetContextUri(resourceLink!.uri!)).toEqual({
      path: "notes.md",
      pos: 42,
      selectedRange: { from: 3, to: 25 },
    });
  });

  it("task(id).promptFromWidget() embeds an empty-doc framing sentence and sends no context parts", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    let promptParams: unknown;
    agent.onPrompt = async (params) => {
      promptParams = params;
      return { stopReason: "end_turn" };
    };

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);

    const handle = agents.task(task.taskId);
    await handle.promptFromWidget("write an intro", {
      path: "new-doc.md",
      pos: 0,
      isDocEmpty: true,
    }).completed;

    const prompt = (
      promptParams as { prompt: Array<{ type: string; text?: string }> }
    ).prompt;
    expect(prompt).toHaveLength(1);
    expect(prompt[0].type).toBe("text");
    expect(prompt[0].text).toContain("new-doc.md is currently empty");
    expect(prompt[0].text).toContain("write an intro");
  });

  it("turn(id).get() reads the live turn row", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(() => client);
    const { turnId, completed } = task.prompt("hi");
    await completed;

    const row = agents.turn(turnId).get();
    expect(row?.status).toBe("completed");
  });
});

describe("task reachability (MET-163)", () => {
  it("is false for a task that never existed", async () => {
    expect(await agents.task("task_nope").isReachable()).toBe(false);
  });

  it("is true for a restored row a prompt would revive", async () => {
    agentTasksCollection.insert({
      taskId: "task_restored",
      workspacePath: "/ws",
      title: "restored",
      status: "restored",
      harnessId: harness.id,
      sessionId: "sess_1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await agents.task("task_restored").isReachable()).toBe(true);
  });

  it("is false once a row has been demoted to unavailable", async () => {
    agentTasksCollection.insert({
      taskId: "task_dead",
      workspacePath: "/ws",
      title: "dead",
      status: "unavailable",
      harnessId: harness.id,
      sessionId: "sess_2",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await agents.task("task_dead").isReachable()).toBe(false);
  });

  it("is false for a row with no session to resume", async () => {
    agentTasksCollection.insert({
      taskId: "task_sessionless",
      workspacePath: "/ws",
      title: "no session",
      status: "restored",
      harnessId: harness.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await agents.task("task_sessionless").isReachable()).toBe(false);
  });
});

describe("splitLeadingQuote", () => {
  it("splits a leading blockquote off the prompt", () => {
    expect(splitLeadingQuote("> quoted line\n> second\n\nask me")).toEqual({
      quote: "quoted line\nsecond",
      rest: "ask me",
    });
  });

  it("leaves prompts without a leading quote untouched", () => {
    expect(splitLeadingQuote("ask about > this")).toEqual({
      quote: null,
      rest: "ask about > this",
    });
  });

  it("leaves a mid-prompt quote in the rest", () => {
    expect(splitLeadingQuote("intro\n> not a reference")).toEqual({
      quote: null,
      rest: "intro\n> not a reference",
    });
  });

  it("handles a quote-only prompt", () => {
    expect(splitLeadingQuote("> only quote")).toEqual({
      quote: "only quote",
      rest: "",
    });
  });
});
