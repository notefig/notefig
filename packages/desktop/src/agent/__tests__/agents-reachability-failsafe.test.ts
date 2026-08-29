/**
 * The one reachability answer that destroys user data: `isReachable()` false
 * makes the node view delete a persisted prompt widget and strip its marker
 * from the document (MET-163). Storage that fails to load looks exactly like
 * a user with no sessions, so that case must answer "don't know" instead.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: { writeFiles: vi.fn(), readFiles: vi.fn() },
    proc: { createMcpEndpoint: vi.fn() },
  },
}));

// Reconciliation could not be trusted this run (corrupt/unreadable storage).
vi.mock("../agent-collections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-collections")>()),
  whenAgentTasksReconciled: vi.fn(async () => false),
}));

import { agents } from "../agents";
import { agentTasksCollection } from "../agent-collections";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

describe("reachability when reconciliation failed", () => {
  it("keeps an unknown task reachable rather than reporting it gone", async () => {
    expect(await agents.task("task_unknown").isReachable()).toBe(true);
  });

  it("still trusts a row that says it is unavailable", async () => {
    // A row is positive evidence regardless: it loaded, and it says the
    // harness-side session is gone.
    agentTasksCollection.insert({
      taskId: "task_unavailable",
      workspacePath: "/ws",
      title: "gone",
      status: "unavailable",
      harnessId: BUILT_IN_HARNESSES[0].id,
      sessionId: "sess_1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await agents.task("task_unavailable").isReachable()).toBe(false);
  });
});
