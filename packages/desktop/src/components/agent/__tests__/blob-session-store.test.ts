import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", () => ({ platformAdapter: {} }));
vi.mock("@/agent/agent-service", () => ({
  startAgentTask: vi.fn(),
}));

import { startAgentTask } from "@/agent/agent-service";
import { agentTasksCollection } from "@/agent/agent-collections";
import {
  getOrStartSharedSession,
  dropSharedSession,
  peekSharedSession,
  resetSharedSessionsForTest,
} from "../blob-session-store";

const startMock = vi.mocked(startAgentTask);
const HARNESS = { id: "claude-code", label: "Claude Code" } as never;

let nextTask = 0;
function stubStart(status: "idle" | "error" = "idle") {
  const taskId = `task_${++nextTask}`;
  startMock.mockImplementationOnce((workspacePath: string) => {
    agentTasksCollection.insert({
      taskId,
      workspacePath,
      title: "t",
      status,
      harnessId: "claude-code",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { taskId, started: Promise.resolve() };
  });
  return taskId;
}

beforeEach(() => {
  resetSharedSessionsForTest();
  startMock.mockReset();
  for (const row of agentTasksCollection.toArray) {
    agentTasksCollection.delete(row.taskId);
  }
});

describe("blob-session-store", () => {
  it("starts lazily once and reuses the live session", async () => {
    const taskId = stubStart();
    const first = await getOrStartSharedSession("/ws", HARNESS);
    const second = await getOrStartSharedSession("/ws", HARNESS);
    expect(first.taskId).toBe(taskId);
    expect(second.taskId).toBe(taskId);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("keeps workspaces separate", async () => {
    const a = stubStart();
    const b = stubStart();
    expect((await getOrStartSharedSession("/ws-a", HARNESS)).taskId).toBe(a);
    expect((await getOrStartSharedSession("/ws-b", HARNESS)).taskId).toBe(b);
  });

  it("restarts when the cached task row is dead", async () => {
    const dead = stubStart();
    await getOrStartSharedSession("/ws", HARNESS);
    agentTasksCollection.update(dead, (draft) => {
      draft.status = "error";
    });
    const fresh = stubStart();
    expect((await getOrStartSharedSession("/ws", HARNESS)).taskId).toBe(fresh);
  });

  it("dropSharedSession forgets without spawning; next send starts fresh", async () => {
    const first = stubStart();
    await getOrStartSharedSession("/ws", HARNESS);
    dropSharedSession("/ws");
    expect(peekSharedSession("/ws")).toBeNull();
    expect(startMock).toHaveBeenCalledTimes(1);

    const second = stubStart();
    expect((await getOrStartSharedSession("/ws", HARNESS)).taskId).toBe(second);
    expect(second).not.toBe(first);
  });

  it("peekSharedSession reflects liveness", async () => {
    expect(peekSharedSession("/ws")).toBeNull();
    const taskId = stubStart();
    await getOrStartSharedSession("/ws", HARNESS);
    expect(peekSharedSession("/ws")).toBe(taskId);
    agentTasksCollection.update(taskId, (draft) => {
      draft.status = "cancelled";
    });
    expect(peekSharedSession("/ws")).toBeNull();
  });
});
