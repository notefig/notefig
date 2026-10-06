import { describe, it, expect, vi, beforeEach } from "vitest";

// The shared session starts its task through the workspace's agents handle.
const startAgentTask = vi.fn<
  (
    workspacePath: string,
    harness: unknown,
  ) => { taskId: string; started: Promise<void> }
>();

import type { AgentTasksCollection } from "@/modules/agents/agent-collections";
import {
  createSharedSessions,
  type SharedSessionsApi,
} from "./shared-sessions";
import { testAgentStore } from "@/testing/test-agents";

const startMock = startAgentTask;
const HARNESS = { id: "claude-code", label: "Claude Code" } as never;

let tasks: AgentTasksCollection;
let sessions: SharedSessionsApi;

let nextTask = 0;
function stubStart(status: "idle" | "error" = "idle") {
  const taskId = `task_${++nextTask}`;
  startMock.mockImplementationOnce((workspacePath: string) => {
    tasks.insert({
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
 *  adopt tests, which must never start a task. */
function insertTask(
  workspacePath: string,
  status: "idle" | "running" | "error" | "cancelled" = "idle",
) {
  const taskId = `task_${++nextTask}`;
  tasks.insert({
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
  startMock.mockReset();
  tasks = testAgentStore().tasks;
  sessions = createSharedSessions({
    agents: {
      workspace: (workspacePath: string) =>
        ({
          startTask: (harness: unknown) =>
            startAgentTask(workspacePath, harness),
        }) as never,
    },
    tasks,
  });
});

describe("blob-session-store", () => {
  it("starts lazily once and reuses the live session", async () => {
    const taskId = stubStart();
    const first = await sessions.getOrStart("/ws", HARNESS);
    const second = await sessions.getOrStart("/ws", HARNESS);
    expect(first.taskId).toBe(taskId);
    expect(second.taskId).toBe(taskId);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("keeps workspaces separate", async () => {
    const a = stubStart();
    const b = stubStart();
    expect((await sessions.getOrStart("/ws-a", HARNESS)).taskId).toBe(a);
    expect((await sessions.getOrStart("/ws-b", HARNESS)).taskId).toBe(b);
  });

  it("restarts when the cached task row is dead", async () => {
    const dead = stubStart();
    await sessions.getOrStart("/ws", HARNESS);
    tasks.update(dead, (draft) => {
      draft.status = "error";
    });
    const fresh = stubStart();
    expect((await sessions.getOrStart("/ws", HARNESS)).taskId).toBe(fresh);
  });

  it("drop forgets without spawning; next send starts fresh", async () => {
    const first = stubStart();
    await sessions.getOrStart("/ws", HARNESS);
    sessions.drop("/ws");
    expect(sessions.peek("/ws")).toBeNull();
    expect(startMock).toHaveBeenCalledTimes(1);

    const second = stubStart();
    expect((await sessions.getOrStart("/ws", HARNESS)).taskId).toBe(second);
    expect(second).not.toBe(first);
  });

  it("peek reflects liveness", async () => {
    expect(sessions.peek("/ws")).toBeNull();
    const taskId = stubStart();
    await sessions.getOrStart("/ws", HARNESS);
    expect(sessions.peek("/ws")).toBe(taskId);
    tasks.update(taskId, (draft) => {
      draft.status = "cancelled";
    });
    expect(sessions.peek("/ws")).toBeNull();
  });
});

describe("adopt", () => {
  it("adopts a live task without starting a new one", async () => {
    const taskId = insertTask("/ws");
    sessions.adopt("/ws", taskId);
    expect((await sessions.getOrStart("/ws", HARNESS)).taskId).toBe(taskId);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("no-ops when the taskId is missing", async () => {
    sessions.adopt("/ws", "task_missing");
    expect(sessions.peek("/ws")).toBeNull();
  });

  it("no-ops when the task is errored or cancelled", async () => {
    const errored = insertTask("/ws", "error");
    sessions.adopt("/ws", errored);
    expect(sessions.peek("/ws")).toBeNull();

    const cancelled = insertTask("/ws", "cancelled");
    sessions.adopt("/ws", cancelled);
    expect(sessions.peek("/ws")).toBeNull();
  });

  it("drop after adopting starts fresh on next send", async () => {
    const adopted = insertTask("/ws");
    sessions.adopt("/ws", adopted);
    sessions.drop("/ws");
    expect(sessions.peek("/ws")).toBeNull();

    const fresh = stubStart();
    expect((await sessions.getOrStart("/ws", HARNESS)).taskId).toBe(fresh);
  });

  it("adopted session going dead falls back to starting fresh", async () => {
    const adopted = insertTask("/ws");
    sessions.adopt("/ws", adopted);
    tasks.update(adopted, (draft) => {
      draft.status = "error";
    });
    expect(sessions.peek("/ws")).toBeNull();

    const fresh = stubStart();
    expect((await sessions.getOrStart("/ws", HARNESS)).taskId).toBe(fresh);
  });
});
