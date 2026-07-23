import { describe, expect, it } from "vitest";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
  getLastSentPrompt,
  setLastSentPrompt,
} from "../composer-draft-store";

describe("composer-draft-store", () => {
  it("stores and returns drafts per task", () => {
    setComposerDraft("task_a", "hello");
    setComposerDraft("task_b", "world");
    expect(getComposerDraft("task_a")).toBe("hello");
    expect(getComposerDraft("task_b")).toBe("world");
  });

  it("returns empty string for unknown tasks", () => {
    expect(getComposerDraft("task_unknown")).toBe("");
  });

  it("setting an empty draft deletes the entry", () => {
    setComposerDraft("task_c", "draft");
    setComposerDraft("task_c", "");
    expect(getComposerDraft("task_c")).toBe("");
  });

  it("clear removes the draft", () => {
    setComposerDraft("task_d", "draft");
    clearComposerDraft("task_d");
    expect(getComposerDraft("task_d")).toBe("");
  });

  it("tracks the last sent prompt per task, independent of the draft (MET-94)", () => {
    setLastSentPrompt("task_e", "sent text");
    setComposerDraft("task_e", "new draft");
    expect(getLastSentPrompt("task_e")).toBe("sent text");
    expect(getComposerDraft("task_e")).toBe("new draft");
    expect(getLastSentPrompt("task_unknown")).toBe("");
  });
});
