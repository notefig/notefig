import { describe, it, expect, vi } from "vitest";
import {
  adoptPersistedPromptBinding,
  getPromptBlob,
  updatePromptBlob,
  clearPromptBlobTurn,
  subscribePromptBlob,
  requestPromptBlobFocus,
  subscribePromptBlobFocus,
  consumePendingPromptBlobFocus,
} from "../prompt-blob-store";

describe("prompt-blob-store", () => {
  it("returns an empty record for unknown paths", () => {
    expect(getPromptBlob("/ws/unknown.md")).toEqual({
      draft: "",
      boundTurnId: null,
      boundTaskId: null,
      lastSentPrompt: "",
    });
  });

  it("patches persist across reads (remount restoration)", () => {
    updatePromptBlob("/ws/a.md", { draft: "hello" });
    updatePromptBlob("/ws/a.md", {
      boundTurnId: "trn_1",
      boundTaskId: "task_1",
    });
    expect(getPromptBlob("/ws/a.md")).toMatchObject({
      draft: "hello",
      boundTurnId: "trn_1",
      boundTaskId: "task_1",
    });
  });

  it("clearPromptBlobTurn unbinds the turn but keeps the draft", () => {
    updatePromptBlob("/ws/b.md", {
      draft: "keep me",
      boundTurnId: "trn_2",
      boundTaskId: "task_2",
      lastSentPrompt: "sent",
    });
    clearPromptBlobTurn("/ws/b.md");
    expect(getPromptBlob("/ws/b.md")).toMatchObject({
      draft: "keep me",
      boundTurnId: null,
      boundTaskId: null,
      lastSentPrompt: "sent",
    });
  });

  it("notifies subscribers on its path only, until unsubscribed", () => {
    const onC = vi.fn();
    const onD = vi.fn();
    const unsubscribe = subscribePromptBlob("/ws/c.md", onC);
    subscribePromptBlob("/ws/d.md", onD);

    updatePromptBlob("/ws/c.md", { draft: "x" });
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onD).not.toHaveBeenCalled();

    unsubscribe();
    updatePromptBlob("/ws/c.md", { draft: "y" });
    expect(onC).toHaveBeenCalledTimes(1);
  });

  it("snapshot identity is stable between writes (useSyncExternalStore)", () => {
    updatePromptBlob("/ws/e.md", { draft: "z" });
    expect(getPromptBlob("/ws/e.md")).toBe(getPromptBlob("/ws/e.md"));
  });

  // The multi-widget regression: two widgets (distinct blobIds) in the same
  // document must never share drafts or turn bindings.
  it("keeps records under different ids fully independent", () => {
    updatePromptBlob("blob_one", { draft: "first", boundTurnId: "trn_1" });
    updatePromptBlob("blob_two", { draft: "second" });
    updatePromptBlob("blob_one", { boundTurnId: "trn_9", draft: "" });
    expect(getPromptBlob("blob_two")).toMatchObject({
      draft: "second",
      boundTurnId: null,
    });
    expect(getPromptBlob("blob_one")).toMatchObject({
      draft: "",
      boundTurnId: "trn_9",
    });
  });
});

describe("persisted binding adoption (MET-163)", () => {
  it("binds a widget restored from the document to its session", () => {
    adoptPersistedPromptBinding("blob_restored", "task_7");
    expect(getPromptBlob("blob_restored")).toMatchObject({
      boundTaskId: "task_7",
      // No turn: turns don't outlive the app, so a restored widget composes
      // against its old session rather than replaying a dead round.
      boundTurnId: null,
    });
  });

  it("never clobbers a live round (adoption mid-turn)", () => {
    updatePromptBlob("blob_live", {
      boundTurnId: "trn_live",
      boundTaskId: "task_live",
      draft: "typing",
    });
    // An agent write re-parses the document; the node comes back with the
    // same ids it was serialized with and must not reset the round.
    adoptPersistedPromptBinding("blob_live", "task_live");
    expect(getPromptBlob("blob_live")).toMatchObject({
      boundTurnId: "trn_live",
      boundTaskId: "task_live",
      draft: "typing",
    });
  });
});

describe("prompt-blob focus channel", () => {
  it("notifies a mounted subscriber and stays pending for a late mount", () => {
    const onFocus = vi.fn();
    const unsubscribe = subscribePromptBlobFocus("/ws/f.md", onFocus);
    requestPromptBlobFocus("/ws/f.md");
    expect(onFocus).toHaveBeenCalledTimes(1);
    // The request also remains pending until consumed (late-mount case).
    expect(consumePendingPromptBlobFocus("/ws/f.md")).toBe(true);
    unsubscribe();
  });

  it("consume is one-shot and per-path", () => {
    requestPromptBlobFocus("/ws/g.md");
    expect(consumePendingPromptBlobFocus("/ws/other.md")).toBe(false);
    expect(consumePendingPromptBlobFocus("/ws/g.md")).toBe(true);
    expect(consumePendingPromptBlobFocus("/ws/g.md")).toBe(false);
  });
});
