import { describe, it, expect, vi } from "vitest";

// The hook module reaches @/adapters via @/utils/fs; describeTaskMeta itself
// is pure, so a stub adapter keeps this a plain unit test.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

import { describeTaskMeta, type AgentTaskMeta } from "./agents";
import type { AgentTaskRow } from "@/agent/agent-collections";

function meta(overrides: Partial<AgentTaskMeta> = {}): AgentTaskMeta {
  const task: AgentTaskRow = {
    taskId: "task_1",
    workspacePath: "/ws",
    title: "t",
    status: "idle",
    harnessId: "claude-code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    task,
    queuedCount: 0,
    isRunning: false,
    needsAuth: false,
    isError: false,
    isUnavailable: false,
    ...overrides,
  };
}

describe("describeTaskMeta", () => {
  it("sign-in outranks everything", () => {
    expect(
      describeTaskMeta(
        meta({ needsAuth: true, isRunning: true, queuedCount: 2 }),
      ),
    ).toBe("needs sign-in");
  });

  it("running, with and without a queue", () => {
    expect(describeTaskMeta(meta({ isRunning: true }))).toBe("running");
    expect(describeTaskMeta(meta({ isRunning: true, queuedCount: 2 }))).toBe(
      "running · 2 queued",
    );
  });

  it("queued without running (auth-halted or starting drain)", () => {
    expect(describeTaskMeta(meta({ queuedCount: 1 }))).toBe("1 queued");
  });

  it("failed outranks the timestamp", () => {
    expect(describeTaskMeta(meta({ isError: true }))).toBe("failed");
  });

  it("idle falls through to relative time", () => {
    expect(describeTaskMeta(meta())).toBe("just now");
  });
});
