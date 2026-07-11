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
  platformAdapter: {
    setKv: vi.fn(),
    getKv: vi.fn(),
    writeFiles,
    readFiles,
    createMcpTransport: vi.fn(() => ({
      locus: "local",
      mcpServer: { name: "metrists", command: "metrists", args: [], env: [] },
      start: vi.fn(async () => {}),
      send: vi.fn(),
      onLine: vi.fn(() => () => {}),
      onClose: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    })),
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { createLoopbackPair } from "../loopback-transport";
import { FakeAgent } from "./fake-agent";
import { TaskManager } from "../agent-service";
import { agents } from "../agents";
import {
  agentEntriesCollection,
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
