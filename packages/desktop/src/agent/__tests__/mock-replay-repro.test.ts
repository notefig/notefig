import { describe, it, expect, vi } from "vitest";
import { createMockAgentTransport } from "../mock-harness";
import { TaskManager } from "../agent-service";
import { testAgents } from "@/testing/test-agents";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

describe("scenario-agent replay (repro)", () => {
  it("refreshFromHarness replays the recorded scenario history", async () => {
    const { deps, store } = testAgents();
    const task = new TaskManager(deps, "/ws").createTask(BUILT_IN_HARNESSES[0]);
    await task.start(() => createMockAgentTransport());
    task.prompt("codeword ORCA");
    await vi.waitFor(() => {
      const turns = store.turns.toArray.filter((t) => t.taskId === task.taskId);
      expect(turns.some((t) => t.status === "completed")).toBe(true);
    });
    const before = store.entries.toArray.filter((e) => e.taskId === task.taskId);
    expect(before.length).toBeGreaterThan(0);

    const result = await task.refreshFromHarness();
    expect(result).toEqual({ ok: true });

    const after = store.entries.toArray.filter((e) => e.taskId === task.taskId);
    expect(after.map((e) => [e.type, e.text?.slice(0, 20)])).not.toEqual([]);
    expect(after.some((e) => e.type === "user" && e.text?.includes("ORCA"))).toBe(true);
  });
});
