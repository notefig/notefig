import { describe, expect, it, vi } from "vitest";
import { testPrompts } from "../../testing/test-prompts";
import {
  discardPromptChanges,
  getDocumentPromptChanges,
  setDocumentPromptChanges,
} from "../change-store";

const ROUND = { taskId: "task_1", turnId: "trn_1" };

describe("createPromptWidgets", () => {
  it("walks a round from send to settled, following the agent's rows", async () => {
    const t = testPrompts();
    const seen: string[] = [];
    t.prompts.subscribe("blob", () => seen.push(t.prompts.get("blob").state.name));

    expect(await t.send("blob", "summarize", ROUND)).toBe(true);
    expect(t.prompts.get("blob")).toMatchObject({
      state: { name: "working", turn: "queued" },
      boundTaskId: "task_1",
      boundTurnId: "trn_1",
      lastSentPrompt: "summarize",
    });
    expect(seen[0]).toBe("sending");

    t.setTurn("trn_1", "task_1", "running");
    expect(t.prompts.get("blob").state).toEqual({ name: "working", turn: "running" });
    t.setPendingPermission("task_1", true);
    expect(t.prompts.get("blob").state).toEqual({
      name: "asking",
      ask: { kind: "permission" },
    });
    t.setPendingPermission("task_1", false);
    t.setTurn("trn_1", "task_1", "completed");
    expect(t.prompts.get("blob").state).toEqual({ name: "settled", outcome: "done" });
  });

  it("treats a turn row that hasn't appeared yet as queued, and a vanished one as stale", async () => {
    const t = testPrompts();
    await t.prompts.send("blob", "hi", async () => ROUND);
    expect(t.prompts.get("blob").state).toEqual({ name: "working", turn: "queued" });
    t.setTurn("trn_1", "task_1", "running");
    t.removeTurn("trn_1");
    expect(t.prompts.get("blob")).toMatchObject({
      state: { name: "composing" },
      boundTaskId: null,
      boundTurnId: null,
      lastSentPrompt: "hi",
    });
  });

  it("returns to composing when the dispatch fails", async () => {
    const t = testPrompts();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await t.prompts.send("blob", "hi", async () => {
        throw new Error("no session");
      }),
    ).toBe(false);
    expect(t.prompts.get("blob").state.name).toBe("composing");
    error.mockRestore();
  });

  it("won't send while a round is live", async () => {
    const t = testPrompts();
    await t.send("blob", "first", ROUND);
    const dispatch = vi.fn(async () => ({ taskId: "task_1", turnId: "trn_2" }));
    expect(await t.prompts.send("blob", "second", dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("withdraws a queued turn and cancels a running one", async () => {
    const t = testPrompts();
    await t.send("blob", "hi", ROUND);
    expect(t.prompts.stop("blob", t.commands)).toBe("withdrawn");
    expect(t.commands.removeQueuedPrompt).toHaveBeenCalledWith("task_1", "trn_1");
    expect(t.prompts.get("blob").boundTurnId).toBeNull();

    await t.send("blob", "again", { taskId: "task_1", turnId: "trn_2" });
    t.setTurn("trn_2", "task_1", "running");
    expect(t.prompts.stop("blob", t.commands)).toBe("cancelled");
    expect(t.commands.cancelTask).toHaveBeenCalledWith("task_1");
    expect(t.prompts.get("blob").boundTurnId).toBe("trn_2");
    expect(t.prompts.stop("other", t.commands)).toBe("none");
  });

  it("restores a persisted session without clobbering a live one", async () => {
    const t = testPrompts();
    t.prompts.restore("blob_restored", "task_7");
    expect(t.prompts.get("blob_restored")).toMatchObject({
      state: { name: "composing" },
      boundTaskId: "task_7",
      boundTurnId: null,
    });

    await t.send("blob_live", "hi", ROUND);
    t.prompts.restore("blob_live", "task_other");
    expect(t.prompts.get("blob_live").boundTaskId).toBe("task_1");
  });

  it("finds the widget for a task, preferring the one watching a turn", async () => {
    const t = testPrompts();
    await t.send("blob_a", "a", { taskId: "task_x", turnId: "trn_a" });
    expect(t.prompts.findByTask("task_x")).toBeNull();
    t.prompts.setDocument("blob_a", "/ws/a.md");
    await t.send("blob_b", "b", { taskId: "task_x", turnId: "trn_b" });
    t.prompts.setDocument("blob_b", "/ws/b.md");
    expect(t.prompts.findByTask("task_x", "trn_b")).toEqual({
      blobId: "blob_b",
      documentPath: "/ws/b.md",
      boundTurnId: "trn_b",
    });
    expect(t.prompts.findByTask("task_x", "trn_none")).toBeNull();
    expect(t.prompts.findByTask("task_x")?.blobId).toBe("blob_a");
    expect(t.prompts.findByTask("task_other")).toBeNull();
  });

  it("is silent when nothing changed, and keeps a stable snapshot", () => {
    const t = testPrompts();
    const listener = vi.fn();
    t.prompts.subscribe("blob", listener);
    t.prompts.setDocument("blob", "/ws/e.md");
    t.prompts.setDocument("blob", "/ws/e.md");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(t.prompts.get("blob")).toBe(t.prompts.get("blob"));
  });

  it("Escape belongs to the newest stoppable turn in each document", async () => {
    const t = testPrompts();
    for (const [blobId, turnId, doc] of [
      ["blob_old", "trn_1", "/ws/a.md"],
      ["blob_new", "trn_2", "/ws/a.md"],
      ["blob_elsewhere", "trn_3", "/ws/b.md"],
    ] as const) {
      t.prompts.setDocument(blobId, doc);
      await t.send(blobId, "hi", { taskId: "task_1", turnId });
    }
    expect(t.prompts.isNewestStoppable("blob_old")).toBe(false);
    expect(t.prompts.isNewestStoppable("blob_new")).toBe(true);
    expect(t.prompts.isNewestStoppable("blob_elsewhere")).toBe(true);
    t.prompts.unbind("blob_new");
    expect(t.prompts.isNewestStoppable("blob_old")).toBe(true);
  });

  it("forgets a widget's tracked changes when it binds a new turn", async () => {
    const t = testPrompts();
    await t.send("blob_r", "one", { taskId: "task_1", turnId: "trn_1" });
    t.setTurn("trn_1", "task_1", "completed");
    setDocumentPromptChanges("/ws/r.md", [
      { blobId: "blob_r", turnId: "trn_1", from: 1, to: 3 },
      { blobId: "blob_s", turnId: "trn_9", from: 4, to: 5 },
    ]);
    t.prompts.setDocument("blob_r", "/ws/r.md");
    expect(getDocumentPromptChanges("/ws/r.md")).toHaveLength(2);
    await t.send("blob_r", "two", { taskId: "task_1", turnId: "trn_2" });
    expect(getDocumentPromptChanges("/ws/r.md")).toEqual([
      { blobId: "blob_s", turnId: "trn_9", from: 4, to: 5 },
    ]);
    discardPromptChanges("blob_s");
  });
});
