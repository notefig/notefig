import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
const widgets = vi.hoisted(() => ({
  bound: null as null | { blobId: string; documentPath: string; boundTurnId: string },
}));
vi.mock("@notefig/widgets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@notefig/widgets")>()),
  findPromptBlobForTask: () => widgets.bound,
}));

import {
  isTurnUnseen,
  recordSettledTurn,
  setActiveTabForUnseen,
  startUnseenTracking,
  targetOfTab,
  targetsOfSettledTurn,
  unseenCollection,
} from "./unseen";
import { agentTabId, RELEASE_NOTES_TAB_ID } from "@/entities/tabs";
import { emitAppEvent } from "@/utils/app-events";

const settled = (taskId: string, turnId: string) =>
  ({ taskId, turnId, status: "completed" }) as const;

describe("unseen tracking", () => {
  beforeEach(async () => {
    widgets.bound = null;
    setActiveTabForUnseen(null);
    await unseenCollection.preload();
    const keys = [...unseenCollection.keys()];
    if (keys.length > 0) await unseenCollection.delete(keys).isPersisted.promise;
  });

  it("maps tabs to targets: task for chat tabs, path for files, nothing else", () => {
    expect(targetOfTab(agentTabId("task_1"))).toBe("task_1");
    expect(targetOfTab("/ws/doc.md")).toBe("/ws/doc.md");
    expect(targetOfTab(RELEASE_NOTES_TAB_ID)).toBeNull();
    expect(targetOfTab(null)).toBeNull();
  });

  it("a widget round lands on its task and its document", () => {
    expect(targetsOfSettledTurn(settled("task_1", "t1"))).toEqual(["task_1"]);
    widgets.bound = { blobId: "b", documentPath: "/ws/doc.md", boundTurnId: "t1" };
    expect(targetsOfSettledTurn(settled("task_1", "t1"))).toEqual(["task_1", "/ws/doc.md"]);
    // A widget on another round of the same task is not this turn's home.
    expect(targetsOfSettledTurn(settled("task_1", "t2"))).toEqual(["task_1"]);
  });

  it("records what settles out of view, and a tab coming to the front clears it", async () => {
    widgets.bound = { blobId: "b", documentPath: "/ws/doc.md", boundTurnId: "t1" };
    setActiveTabForUnseen(agentTabId("task_1")); // the chat tab is in front
    await recordSettledTurn(settled("task_1", "t1"), 5);
    let rows = [...unseenCollection.values()];
    expect(rows.map((r) => r.target)).toEqual(["/ws/doc.md"]);
    expect(isTurnUnseen(rows, "/ws/doc.md", "t1")).toBe(true);
    expect(isTurnUnseen(rows, "task_1", "t1")).toBe(false);

    setActiveTabForUnseen("/ws/doc.md");
    await vi.waitFor(() => expect(unseenCollection.size).toBe(0));

    // Nothing in front: both targets are marked, once each.
    setActiveTabForUnseen(null);
    await recordSettledTurn(settled("task_1", "t1"), 6);
    await recordSettledTurn(settled("task_1", "t1"), 7);
    rows = [...unseenCollection.values()];
    expect(rows.map((r) => r.target).sort()).toEqual(["/ws/doc.md", "task_1"]);
  });

  it("the boot listener records settled turns from the app event", async () => {
    const stop = startUnseenTracking();
    emitAppEvent("agent:turn-settled", settled("task_9", "t9"));
    await vi.waitFor(() => expect(unseenCollection.get("task_9:t9")).toBeDefined());
    stop();
  });
});
