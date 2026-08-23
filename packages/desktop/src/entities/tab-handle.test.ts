import { describe, expect, it } from "vitest";
import { tab } from "./tabs";

describe("tab()", () => {
  it("carries the type-specific half of each kind's API", () => {
    const file = tab("/ws/notes.md");
    if (file.kind !== "file") throw new Error("expected a file tab");
    expect(file.editor.filePath).toBe("/ws/notes.md");

    const agent = tab("agent:task_1");
    if (agent.kind !== "agent") throw new Error("expected an agent tab");
    expect(agent.agent.taskId).toBe("task_1");
  });

  it("is inert on a tab whose surface isn't live", async () => {
    const handle = tab("/ws/notes.md");

    expect(handle.isMounted()).toBe(false);
    expect(handle.focus()).toBe(false);
    expect(handle.selectedText()).toBeUndefined();
    await expect(handle.search("anything")).resolves.toEqual([]);
  });
});
