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
vi.mock("@/adapters", () => ({
  platformAdapter: { setKv: vi.fn(), getKv: vi.fn(), writeFiles, readFiles },
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "./fake-agent";
import { TaskManager } from "../agent-service";
import { agents } from "../agents";
import {
  agentEntriesCollection,
  agentInteractionsCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";

const harness = BUILT_IN_HARNESSES[0];

beforeEach(() => {
  for (const e of agentEntriesCollection.toArray) agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
  for (const i of agentInteractionsCollection.toArray)
    agentInteractionsCollection.delete(i.id);
});

describe("agents facade (Stage 1)", () => {
  it("task(id) actions fail as values for an unknown/disposed task", async () => {
    const handle = agents.task("task_does_not_exist");
    expect(handle.prompt("hi")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await handle.cancel()).toEqual({ ok: false, error: expect.any(String) });
    expect(
      handle.respondPermission("req_1", { outcome: { outcome: "cancelled" } }),
    ).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it("task(id).prompt() drives the same underlying AgentTask as the raw class", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    const handle = agents.task(task.taskId);
    const result = handle.prompt("hello");
    expect("turnId" in result).toBe(true);
    const outcome = await (result as { completed: Promise<unknown> }).completed;
    expect(outcome).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it("interaction(id) answer()/cancel() fail as values when the interaction is missing", () => {
    const handle = agents.interaction("itx_missing");
    expect(handle.answer("yes")).toEqual({ ok: false, error: expect.any(String) });
    expect(handle.cancel()).toEqual({ ok: false, error: expect.any(String) });
  });

  it("interaction(id).answer() routes to the owning task", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);

    agentEntriesCollection.insert({
      id: "evt_itx_test",
      taskId: task.taskId,
      turnId: "trn_test",
      type: "tool_call",
      createdAt: Date.now(),
    });
    agentInteractionsCollection.insert({
      id: "itx_test",
      taskId: task.taskId,
      entryId: "evt_itx_test",
      source: "tool",
      state: "pending",
      question: "Proceed?",
      createdAt: Date.now(),
    });

    const result = agents.interaction("itx_test").answer("yes");
    expect(result).toEqual({ ok: true });
    expect(agentInteractionsCollection.get("itx_test")?.state).toBe("answered");
  });

  it("turn(id).get() reads the live turn row", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.onPrompt = async () => ({ stopReason: "end_turn" });

    const task = new TaskManager("/ws").createTask(harness);
    await task.start(client);
    const { turnId, completed } = task.prompt("hi");
    await completed;

    const row = agents.turn(turnId).get();
    expect(row?.status).toBe("completed");
  });
});
