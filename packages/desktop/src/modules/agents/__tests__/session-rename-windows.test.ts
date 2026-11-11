import { describe, it, expect, vi } from "vitest";
import { createLoopbackPair } from "@notefig/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { FakeAgent } from "../mock-harness";
import { fakeMcpEndpoint, testAgents } from "@/testing/test-agents";

// The app's path flavor is bound when @/utils/path loads, so this suite
// pins the desktop OS before any import: on Windows, workspace paths that
// differ only in case are one workspace.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__NOTEFIG_DESKTOP_OS__ = "windows";
});

describe("session naming on Windows (MET-284)", () => {
  it("refuses a name a saved session holds under another spelling of the workspace", async () => {
    const { store, runtime } = testAgents({
      proc: {
        createMcpEndpoint: fakeMcpEndpoint,
        createAgentTransport: () => {
          throw new Error("tasks start through the transport a test passes");
        },
      },
    });
    // Saved before the workspace was reopened as "c:\work".
    store.tasks.insert({
      taskId: "task_saved",
      workspacePath: "C:\\Work",
      title: "Investor intro",
      status: "restored",
      harnessId: BUILT_IN_HARNESSES[0].id,
      createdAt: 1,
      updatedAt: 1,
    });

    const [client, agentSide] = createLoopbackPair();
    new FakeAgent(agentSide);
    const task = runtime.managerFor("c:\\work").createTask(BUILT_IN_HARNESSES[0]);
    await task.start(() => client);

    const taken = task.rename("Investor intro");
    expect(taken.ok).toBe(false);
    expect(!taken.ok && taken.error).toContain('"Investor intro"');
    expect(task.rename("Pitch deck")).toEqual({ ok: true });
  });
});
