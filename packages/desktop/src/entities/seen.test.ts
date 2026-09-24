import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/entities/workspaces", () => ({ useOpenWorkspaces: () => [] }));

import {
  lastSeenAt,
  markSeen,
  recordSettledTurn,
  seenCollection,
  seenKey,
  setActiveTabForSeen,
  startSeenTracking,
  targetOfSettledTurn,
  targetOfTab,
} from "./seen";
import { promptRoundsCollection, recordRoundStarted } from "./prompt-rounds";
import { agentTabId, RELEASE_NOTES_TAB_ID } from "@/entities/tabs";
import { emitAppEvent } from "@/utils/app-events";

const settled = (taskId: string, turnId: string) =>
  ({ taskId, turnId, status: "completed" }) as const;

describe("seen", () => {
  beforeEach(async () => {
    setActiveTabForSeen(null);
    await seenCollection.preload();
    const keys = [...seenCollection.keys()];
    if (keys.length > 0) await seenCollection.delete(keys).isPersisted.promise;
    await promptRoundsCollection.preload();
    const rounds = [...promptRoundsCollection.keys()];
    if (rounds.length > 0) await promptRoundsCollection.delete(rounds).isPersisted.promise;
  });

  it("maps tabs to targets: task for chat tabs, document for files, nothing else", () => {
    expect(targetOfTab(agentTabId("task_1"))).toEqual({ kind: "task", id: "task_1" });
    expect(targetOfTab("/ws/doc.md")).toEqual({ kind: "document", id: "/ws/doc.md" });
    expect(targetOfTab(RELEASE_NOTES_TAB_ID)).toBeNull();
    expect(targetOfTab(null)).toBeNull();
  });

  it("a widget round lands on its document, a session's own turn on its task", async () => {
    expect(targetOfSettledTurn(settled("task_1", "t1"))).toEqual({ kind: "task", id: "task_1" });
    await recordRoundStarted({
      taskId: "task_1",
      turnId: "t1",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      prompt: "p",
    });
    expect(targetOfSettledTurn(settled("task_1", "t1"))).toEqual({
      kind: "document",
      id: "/ws/doc.md",
    });
  });

  it("a tab in front is seen now, and a seen time never moves backwards", async () => {
    await markSeen({ kind: "task", id: "task_1" }, 10);
    await markSeen({ kind: "task", id: "task_1" }, 5);
    const seen = new Map([...seenCollection.values()].map((r) => [r.id, r.lastSeenAt]));
    expect(lastSeenAt(seen, { kind: "task", id: "task_1" })).toBe(10);
    expect(lastSeenAt(seen, { kind: "task", id: "task_other" })).toBe(0);
  });

  it("a turn settling on the target in front is seen as it lands; elsewhere it is not", async () => {
    setActiveTabForSeen(agentTabId("task_1"));
    await vi.waitFor(() =>
      expect(seenCollection.get(seenKey({ kind: "task", id: "task_1" }))).toBeDefined(),
    );
    const activated = seenCollection.get("task:task_1")!.lastSeenAt;
    await recordSettledTurn(settled("task_1", "t1"), activated + 5);
    expect(seenCollection.get("task:task_1")?.lastSeenAt).toBe(activated + 5);

    await recordSettledTurn(settled("task_2", "t2"), activated + 6);
    expect(seenCollection.get("task:task_2")).toBeUndefined();
  });

  it("the boot listener hears settled turns from the app event", async () => {
    const stop = startSeenTracking();
    setActiveTabForSeen("/ws/doc.md");
    await recordRoundStarted({
      taskId: "task_9",
      turnId: "t9",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      prompt: "p",
    });
    const before = Date.now();
    emitAppEvent("agent:turn-settled", settled("task_9", "t9"));
    await vi.waitFor(() =>
      expect(seenCollection.get("document:/ws/doc.md")?.lastSeenAt).toBeGreaterThanOrEqual(before),
    );
    stop();
  });
});
