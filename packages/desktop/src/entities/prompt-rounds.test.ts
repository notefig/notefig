import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/entities/workspaces", () => ({ useOpenWorkspaces: () => [] }));

import {
  MAX_PROMPT_ROUNDS,
  derivePromptRounds,
  isLiveRound,
  promptRoundsCollection,
  recordRoundSettled,
  recordRoundStarted,
  settleOrphanedRounds,
  startPromptRoundTracking,
} from "./prompt-rounds";
import { emitAppEvent } from "@/utils/app-events";
import { workspaceKey } from "@/utils/path";

const started = (turnId: string, prompt = "Do the thing\nsecond line") => ({
  taskId: "task_1",
  turnId,
  workspacePath: "/ws/a",
  documentPath: "/ws/a/doc.md",
  prompt,
});
const open = [{ key: workspaceKey("/ws/a"), path: "/ws/a" }];

describe("prompt rounds", () => {
  beforeEach(async () => {
    await promptRoundsCollection.preload();
    const keys = [...promptRoundsCollection.keys()];
    if (keys.length > 0) await promptRoundsCollection.delete(keys).isPersisted.promise;
  });

  it("records a started round (first line of the prompt) and settles it", async () => {
    await recordRoundStarted(started("t1"), 10);
    await recordRoundStarted(started("t1"), 11); // idempotent
    expect(promptRoundsCollection.get("t1")).toMatchObject({
      taskId: "task_1",
      documentPath: "/ws/a/doc.md",
      prompt: "Do the thing",
      status: "live",
      startedAt: 10,
    });
    await recordRoundSettled({ taskId: "task_1", turnId: "t1", status: "error", at: 42 });
    await recordRoundSettled({ taskId: "task_1", turnId: "t_unknown", status: "completed", at: 43 });
    expect(promptRoundsCollection.get("t1")).toMatchObject({ status: "error", settledAt: 42 });
    expect(promptRoundsCollection.size).toBe(1);
  });

  it("settles rounds left live by a previous run, keeps live ones with a turn row", async () => {
    await recordRoundStarted(started("t_orphan"), 1);
    await settleOrphanedRounds();
    expect(promptRoundsCollection.get("t_orphan")?.status).toBe("cancelled");
  });

  it("prunes storage to the cap, oldest first", async () => {
    for (let i = 0; i < MAX_PROMPT_ROUNDS + 2; i += 1) {
      await recordRoundStarted(started(`t${i}`), i);
    }
    expect(promptRoundsCollection.size).toBe(MAX_PROMPT_ROUNDS);
    expect(promptRoundsCollection.get("t0")).toBeUndefined();
  });

  it("derives rounds for open workspaces: live first (queued/running off the turn), then newest", () => {
    const key = workspaceKey("/ws/a");
    const row = (turnId: string, status: "live" | "completed", startedAt: number, wsKey = key) => ({
      turnId, taskId: "task_1", workspaceKey: wsKey, documentPath: "/ws/a/doc.md", prompt: "p", status, startedAt,
    });
    const rounds = derivePromptRounds(
      [row("old", "completed", 10), row("new", "completed", 20), row("live", "live", 5), row("queued", "live", 6), row("gone", "live", 7), row("closed", "completed", 99, "other")],
      open,
      [
        { turnId: "queued", status: "queued" },
        { turnId: "live", status: "running" },
      ],
    );
    // "gone" is live with no turn row — the round is over, not running
    // (MET-208): the same answer settleOrphanedRounds writes at boot.
    expect(rounds.map((r) => [r.turnId, r.status])).toEqual([
      ["queued", "queued"],
      ["live", "running"],
      ["new", "completed"],
      ["old", "completed"],
      ["gone", "cancelled"],
    ]);
    expect(rounds[0].workspacePath).toBe("/ws/a");
    expect(isLiveRound(rounds[0])).toBe(true);
    expect(isLiveRound(rounds[2])).toBe(false);
  });

  it("the boot listener records rounds from the app events", async () => {
    const stop = startPromptRoundTracking();
    emitAppEvent("widget:round-started", started("t9"));
    await vi.waitFor(() => expect(promptRoundsCollection.get("t9")).toBeDefined());
    emitAppEvent("agent:turn-settled", { taskId: "task_1", turnId: "t9", status: "completed", at: 1 });
    await vi.waitFor(() => expect(promptRoundsCollection.get("t9")?.status).toBe("completed"));
    stop();
  });
});
