import { describe, expect, it } from "vitest";
import {
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
} from "../agent-tab-id";

describe("agent-tab-id", () => {
  it("round-trips a taskId through the tab id", () => {
    const tabId = agentTabId("task_abc123");
    expect(tabId).toBe("agent:task_abc123");
    expect(isAgentTabId(tabId)).toBe(true);
    expect(agentTaskIdFromTabId(tabId)).toBe("task_abc123");
  });

  it("rejects file-path tab ids", () => {
    expect(isAgentTabId("/ws/notes.md")).toBe(false);
    expect(isAgentTabId("")).toBe(false);
    expect(isAgentTabId("agents/notes.md")).toBe(false);
    expect(agentTaskIdFromTabId("/ws/notes.md")).toBeNull();
  });
});
