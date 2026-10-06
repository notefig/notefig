import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { CoreProvider } from "@notefig/core/react";
import type { Core } from "@notefig/core";
import {
  agentStoreModule,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import { createTestCore } from "@/testing/test-core";
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
// Real collections over the in-memory SQLite rig, so the hooks read the
// production row shapes; a fresh core (and store) per test.
let core: Core;

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
      createElement(CoreProvider, {
        core,
        children: createElement(Probe<T>, {
          use,
          onValue: (value: T) => {
            latest = value;
          },
        }),
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return () => latest as T;
}

beforeEach(async () => {
  core = createTestCore({ modules: [agentStoreModule] });
  await core.use("agentStore").tasks.preload();
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
    const { tasks } = core.use("agentStore");
    await tasks.insert(row({ taskId: "task_1" })).isPersisted.promise;
    await tasks.insert(row({ taskId: "task_2", workspacePath: "/ws-b" }))
      .isPersisted.promise;

    const read = await renderHook<AgentTaskMeta[]>(() =>
      useAgentTaskList("/ws-a/"),
    );

    expect(read().map((meta) => meta.task.taskId)).toEqual(["task_1"]);
  });
});
