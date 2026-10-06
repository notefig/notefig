import { describe, expect, it } from "vitest";
import { tab } from "./tabs";
import type { AgentTaskHandle } from "@/agent/agents";

const agents = {
  task: (taskId: string) => ({ taskId }) as AgentTaskHandle,
};

describe("tab()", () => {
  it("carries the type-specific half of each kind's API", () => {
    const file = tab("/ws/notes.md", agents);
    if (file.kind !== "file") throw new Error("expected a file tab");
    expect(file.editor.filePath).toBe("/ws/notes.md");

    const agent = tab("agent:task_1", agents);
    if (agent.kind !== "agent") throw new Error("expected an agent tab");
    expect(agent.agent.taskId).toBe("task_1");
  });

  it("is inert on a tab whose surface isn't live", async () => {
    const handle = tab("/ws/notes.md", agents);

    expect(handle.isMounted()).toBe(false);
    expect(handle.focus()).toBe(false);
    expect(handle.selectedText()).toBeUndefined();
    await expect(handle.search("anything")).resolves.toEqual([]);
  });
});
