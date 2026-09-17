import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// Real collections over the in-memory SQLite rig, so the hooks read the
// production row shapes; the fs/proc surfaces are never reached.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import {
  agentTasksCollection,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import { unregisterTask } from "@/agent/task-registry";
import { useAgentTaskList, type AgentTaskMeta } from "./agents";

function row(overrides: Partial<AgentTaskRow> & Pick<AgentTaskRow, "taskId">): AgentTaskRow {
  return {
    workspacePath: "/ws-a",
    title: overrides.taskId,
    status: "idle",
    harnessId: "claude-code",
    sessionId: `sess_${overrides.taskId}`,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe<T>({ use, onValue }: { use: () => T; onValue: (v: T) => void }) {
  const value = use();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

async function renderHook<T>(use: () => T): Promise<() => T> {
  let latest: T | undefined;
  await act(async () => {
    root!.render(
      createElement(Probe<T>, {
        use,
        onValue: (value: T) => {
          latest = value;
        },
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return () => latest as T;
}

beforeEach(async () => {
  for (const task of agentTasksCollection.toArray) {
    unregisterTask(task.taskId);
    await agentTasksCollection.delete(task.taskId).isPersisted.promise;
  }
  await agentTasksCollection.preload();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe("useAgentTaskList", () => {
  it("matches the workspace by workspaceKey, so a respelled path finds its sessions", async () => {
    await agentTasksCollection.insert(row({ taskId: "task_1" })).isPersisted
      .promise;
    await agentTasksCollection.insert(
      row({ taskId: "task_2", workspacePath: "/ws-b" }),
    ).isPersisted.promise;

    const read = await renderHook<AgentTaskMeta[]>(() =>
      useAgentTaskList("/ws-a/"),
    );

    expect(read().map((meta) => meta.task.taskId)).toEqual(["task_1"]);
  });
});
