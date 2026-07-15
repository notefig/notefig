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
  adoptSharedSession,
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

/** Seeds a task row directly, as if it were already live — for
 *  adoptSharedSession tests, which must never call startAgentTask. */
function insertTask(
  workspacePath: string,
  status: "idle" | "running" | "error" | "cancelled" = "idle",
) {
  const taskId = `task_${++nextTask}`;
  agentTasksCollection.insert({
    taskId,
    workspacePath,
    title: "t",
    status,
    harnessId: "claude-code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

describe("adoptSharedSession", () => {
  it("adopts a live task without starting a new one", async () => {
    const taskId = insertTask("/ws");
    adoptSharedSession("/ws", taskId);
    expect((await getOrStartSharedSession("/ws", HARNESS)).taskId).toBe(
      taskId,
    );
    expect(startMock).not.toHaveBeenCalled();
  });

  it("no-ops when the taskId is missing", async () => {
    adoptSharedSession("/ws", "task_missing");
    expect(peekSharedSession("/ws")).toBeNull();
  });

  it("no-ops when the task is errored or cancelled", async () => {
    const errored = insertTask("/ws", "error");
    adoptSharedSession("/ws", errored);
    expect(peekSharedSession("/ws")).toBeNull();

    const cancelled = insertTask("/ws", "cancelled");
    adoptSharedSession("/ws", cancelled);
    expect(peekSharedSession("/ws")).toBeNull();
  });

  it("dropSharedSession after adopting starts fresh on next send", async () => {
    const adopted = insertTask("/ws");
    adoptSharedSession("/ws", adopted);
    dropSharedSession("/ws");
    expect(peekSharedSession("/ws")).toBeNull();

    const fresh = stubStart();
    expect((await getOrStartSharedSession("/ws", HARNESS)).taskId).toBe(
      fresh,
    );
  });

  it("adopted session going dead falls back to starting fresh", async () => {
    const adopted = insertTask("/ws");
    adoptSharedSession("/ws", adopted);
    agentTasksCollection.update(adopted, (draft) => {
      draft.status = "error";
    });
    expect(peekSharedSession("/ws")).toBeNull();

    const fresh = stubStart();
    expect((await getOrStartSharedSession("/ws", HARNESS)).taskId).toBe(
      fresh,
    );
  });
});
