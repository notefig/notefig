import { describe, it, expect, vi } from "vitest";
import {
  adoptPersistedPromptBinding,
  getPromptBlob,
  updatePromptBlob,
  clearPromptBlobTurn,
  subscribePromptBlob,
} from "../store";

describe("prompt-blob-store", () => {
  it("returns an empty record for unknown ids", () => {
    expect(getPromptBlob("blob_unknown")).toEqual({
      boundTurnId: null,
      boundTaskId: null,
      lastSentPrompt: "",
    });
  });

  it("patches persist across reads (remount restoration)", () => {
    updatePromptBlob("blob_a", { lastSentPrompt: "hello" });
    updatePromptBlob("blob_a", {
      boundTurnId: "trn_1",
      boundTaskId: "task_1",
    });
    expect(getPromptBlob("blob_a")).toMatchObject({
      lastSentPrompt: "hello",
      boundTurnId: "trn_1",
      boundTaskId: "task_1",
    });
  });

  it("clearPromptBlobTurn unbinds the turn, keeping the sent prompt", () => {
    updatePromptBlob("blob_b", {
      boundTurnId: "trn_2",
      boundTaskId: "task_2",
      lastSentPrompt: "sent",
    });
    clearPromptBlobTurn("blob_b");
    expect(getPromptBlob("blob_b")).toMatchObject({
      boundTurnId: null,
      boundTaskId: null,
      lastSentPrompt: "sent",
    });
  });

  it("notifies subscribers on its id only, until unsubscribed", () => {
    const onC = vi.fn();
    const onD = vi.fn();
    const unsubscribe = subscribePromptBlob("blob_c", onC);
    subscribePromptBlob("blob_d", onD);

    updatePromptBlob("blob_c", { lastSentPrompt: "x" });
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onD).not.toHaveBeenCalled();

    unsubscribe();
    updatePromptBlob("blob_c", { lastSentPrompt: "y" });
    expect(onC).toHaveBeenCalledTimes(1);
  });

  it("snapshot identity is stable between writes (useSyncExternalStore)", () => {
    updatePromptBlob("blob_e", { lastSentPrompt: "z" });
    expect(getPromptBlob("blob_e")).toBe(getPromptBlob("blob_e"));
  });

  // The multi-widget regression: two widgets (distinct blobIds) in the same
  // document must never share turn bindings.
  it("keeps records under different ids fully independent", () => {
    updatePromptBlob("blob_one", {
      lastSentPrompt: "first",
      boundTurnId: "trn_1",
    });
    updatePromptBlob("blob_two", { lastSentPrompt: "second" });
    updatePromptBlob("blob_one", { boundTurnId: "trn_9" });
    expect(getPromptBlob("blob_two")).toMatchObject({
      lastSentPrompt: "second",
      boundTurnId: null,
    });
    expect(getPromptBlob("blob_one")).toMatchObject({
      lastSentPrompt: "first",
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
    });
    // An agent write re-parses the document; the node comes back with the
    // same ids it was serialized with and must not reset the round.
    adoptPersistedPromptBinding("blob_live", "task_live");
    expect(getPromptBlob("blob_live")).toMatchObject({
      boundTurnId: "trn_live",
      boundTaskId: "task_live",
    });
  });
});
