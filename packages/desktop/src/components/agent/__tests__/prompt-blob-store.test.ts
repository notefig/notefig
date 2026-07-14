import { describe, it, expect, vi } from "vitest";
import {
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
