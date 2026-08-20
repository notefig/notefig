import { describe, it, expect, vi } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      writeFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
      readFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
      deleteFiles: vi.fn(async (paths: string[]) => ({ succeeded: paths, failed: [] })),
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

import { createMockAgentTransport } from "../mock-harness";
import { TaskManager } from "../agent-service";
import { agentEntriesCollection, agentTurnsCollection } from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

describe("scenario-agent replay (repro)", () => {
  it("refreshFromHarness replays the recorded scenario history", async () => {
    const task = new TaskManager("/ws").createTask(BUILT_IN_HARNESSES[0]);
    await task.start(() => createMockAgentTransport());
    task.prompt("codeword ORCA");
    await vi.waitFor(() => {
      const turns = agentTurnsCollection.toArray.filter((t) => t.taskId === task.taskId);
      expect(turns.some((t) => t.status === "completed")).toBe(true);
    });
    const before = agentEntriesCollection.toArray.filter((e) => e.taskId === task.taskId);
    expect(before.length).toBeGreaterThan(0);

    const result = await task.refreshFromHarness();
    expect(result).toEqual({ ok: true });

    const after = agentEntriesCollection.toArray.filter((e) => e.taskId === task.taskId);
    expect(after.map((e) => [e.type, e.text?.slice(0, 20)])).not.toEqual([]);
    expect(after.some((e) => e.type === "user" && e.text?.includes("ORCA"))).toBe(true);
  });
});
