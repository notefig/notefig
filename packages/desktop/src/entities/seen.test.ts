import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createSeen,
  lastSeenAt,
  seenKey,
  targetOfTab,
  type SeenApi,
} from "./seen";
import { createPromptRounds, type PromptRoundsApi } from "./prompt-rounds";
import { agentTabId, RELEASE_NOTES_TAB_ID } from "@/entities/tabs";
import { createNodeTestDb } from "@/testing/node-db";
import { emitAppEvent } from "@/utils/app-events";

const settled = (taskId: string, turnId: string, at = 1) =>
  ({ taskId, turnId, status: "completed", at }) as const;

describe("seen", () => {
  let rounds: PromptRoundsApi;
  let seen: SeenApi;

  beforeEach(() => {
    const db = createNodeTestDb();
    rounds = createPromptRounds({
      persistence: db.get(),
      turns: { get: () => undefined },
    });
    seen = createSeen({ persistence: db.get(), rounds: rounds.collection });
  });

  it("maps tabs to targets: task for chat tabs, document for files, nothing else", () => {
    expect(targetOfTab(agentTabId("task_1"))).toEqual({ kind: "task", id: "task_1" });
    expect(targetOfTab("/ws/doc.md")).toEqual({ kind: "document", id: "/ws/doc.md" });
    expect(targetOfTab(RELEASE_NOTES_TAB_ID)).toBeNull();
    expect(targetOfTab(null)).toBeNull();
  });

  it("a widget round lands on its document, a session's own turn on its task", async () => {
    expect(seen.targetOfSettledTurn(settled("task_1", "t1"))).toEqual({ kind: "task", id: "task_1" });
    await rounds.recordStarted({
      taskId: "task_1",
      turnId: "t1",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      prompt: "p",
    });
    expect(seen.targetOfSettledTurn(settled("task_1", "t1"))).toEqual({
      kind: "document",
      id: "/ws/doc.md",
    });
  });

  it("a tab in front is seen now, and a seen time never moves backwards", async () => {
    await seen.markSeen({ kind: "task", id: "task_1" }, 10);
    await seen.markSeen({ kind: "task", id: "task_1" }, 5);
    const times = new Map([...seen.collection.values()].map((r) => [r.id, r.lastSeenAt]));
    expect(lastSeenAt(times, { kind: "task", id: "task_1" })).toBe(10);
    expect(lastSeenAt(times, { kind: "task", id: "task_other" })).toBe(0);
  });

  it("a turn settling on the target in front is seen as it lands; elsewhere it is not", async () => {
    seen.setActiveTab(agentTabId("task_1"));
    await vi.waitFor(() =>
      expect(seen.collection.get(seenKey({ kind: "task", id: "task_1" }))).toBeDefined(),
    );
    const activated = seen.collection.get("task:task_1")!.lastSeenAt;
    await seen.recordSettledTurn(settled("task_1", "t1", activated + 5));
    expect(seen.collection.get("task:task_1")?.lastSeenAt).toBe(activated + 5);

    await seen.recordSettledTurn(settled("task_2", "t2", activated + 6));
    expect(seen.collection.get("task:task_2")).toBeUndefined();
  });

  it("the boot listener hears settled turns from the app event", async () => {
    const stop = seen.track();
    seen.setActiveTab("/ws/doc.md");
    await rounds.recordStarted({
      taskId: "task_9",
      turnId: "t9",
      workspacePath: "/ws",
      documentPath: "/ws/doc.md",
      prompt: "p",
    });
    const at = Date.now() + 1_000;
    emitAppEvent("agent:turn-settled", settled("task_9", "t9", at));
    // Seen at the turn's own settle time — the value its round stores.
    await vi.waitFor(() =>
      expect(seen.collection.get("document:/ws/doc.md")?.lastSeenAt).toBe(at),
    );
    stop();
  });

  it("a turn settling while the window is in the background needs attention", async () => {
    const stop = seen.track();
    try {
      seen.setActiveTab(agentTabId("task_1"));
      await vi.waitFor(() =>
        expect(seen.collection.get("task:task_1")).toBeDefined(),
      );
      const activated = seen.collection.get("task:task_1")!.lastSeenAt;
      // The blur lands synchronously: a turn settling right after it is not
      // read against the tab that was in front.
      window.dispatchEvent(new Event("blur"));
      await seen.recordSettledTurn(settled("task_1", "t1", activated + 5));
      expect(seen.collection.get("task:task_1")?.lastSeenAt).toBe(activated);

      // Coming back marks it seen.
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() =>
        expect(seen.collection.get("task:task_1")!.lastSeenAt).toBeGreaterThan(
          activated,
        ),
      );
    } finally {
      stop();
    }
  });
});
