/**
 * The session's half of the attention model's bookkeeping: which settles
 * become the task row's `lastSettled`. Decided here, not in the service —
 * this is the listener that can see the prompt-round rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/entities/workspaces", () => ({ useOpenWorkspaces: () => [] }));

import { agentTasksCollection, type AgentTaskRow } from "@/agent/agent-collections";
import { promptRoundsCollection, recordRoundStarted } from "./prompt-rounds";
import { recordSessionSettled, startAttentionTracking } from "./attention";
import { emitAppEvent } from "@/utils/app-events";

const TASK: AgentTaskRow = {
  taskId: "task_1",
  workspacePath: "/ws",
  title: "t",
  status: "idle",
  harnessId: "claude-code",
  createdAt: 1,
  updatedAt: 1,
};
const settled = (turnId: string, status: "completed" | "error" | "cancelled", at: number) =>
  ({ taskId: "task_1", turnId, status, at }) as const;

describe("recordSessionSettled", () => {
  beforeEach(async () => {
    await agentTasksCollection.preload();
    for (const row of [...agentTasksCollection.values()]) {
      await agentTasksCollection.delete(row.taskId).isPersisted.promise;
    }
    await agentTasksCollection.insert(TASK).isPersisted.promise;
    await promptRoundsCollection.preload();
    const rounds = [...promptRoundsCollection.keys()];
    if (rounds.length > 0) await promptRoundsCollection.delete(rounds).isPersisted.promise;
  });

  it("a settle with no prompt round behind it is the session's news, at the turn's own time", async () => {
    await recordSessionSettled(settled("t_chat", "completed", 10));
    expect(agentTasksCollection.get("task_1")?.lastSettled).toEqual({
      turnId: "t_chat",
      at: 10,
      status: "completed",
    });
    await recordSessionSettled(settled("t_bad", "error", 20));
    expect(agentTasksCollection.get("task_1")?.lastSettled?.status).toBe("error");
  });

  it("a widget round's settle never overwrites the session's own news", async () => {
    await recordSessionSettled(settled("t_chat", "completed", 10));
    await recordRoundStarted({
      taskId: "task_1",
      turnId: "t_widget",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      prompt: "p",
    });

    await recordSessionSettled(settled("t_widget", "completed", 20));

    expect(agentTasksCollection.get("task_1")?.lastSettled?.turnId).toBe("t_chat");
  });

  it("a cancel says nothing, and a task with no row is left alone", async () => {
    await recordSessionSettled(settled("t_cancel", "cancelled", 10));
    expect(agentTasksCollection.get("task_1")?.lastSettled).toBeUndefined();
    await expect(
      recordSessionSettled({ ...settled("t", "completed", 10), taskId: "task_gone" }),
    ).resolves.toBeUndefined();
  });

  it("the boot listener hears settles from the app event", async () => {
    const stop = startAttentionTracking();
    emitAppEvent("agent:turn-settled", settled("t9", "completed", 99));
    await vi.waitFor(() =>
      expect(agentTasksCollection.get("task_1")?.lastSettled?.turnId).toBe("t9"),
    );
    stop();
  });
});
