import { describe, expect, it } from "vitest";
import {
  agentTabId,
  isFileTabId,
  parseTabId,
  tabKind,
  RELEASE_NOTES_TAB_ID,
} from "../tab-id";

describe("parseTabId", () => {
  it("decodes a file path into a file ref", () => {
    expect(parseTabId("/ws/notes.md")).toEqual({
      kind: "file",
      tabId: "/ws/notes.md",
      path: "/ws/notes.md",
    });
  });

  it("decodes an agent tab into its task id", () => {
    expect(parseTabId(agentTabId("task_1"))).toEqual({
      kind: "agent",
      tabId: "agent:task_1",
      taskId: "task_1",
    });
  });

  it("decodes the singleton release-notes tab", () => {
    expect(parseTabId(RELEASE_NOTES_TAB_ID)).toEqual({
      kind: "release-notes",
      tabId: RELEASE_NOTES_TAB_ID,
    });
  });

  it("treats a path that merely mentions a scheme as a file", () => {
    // Schemes can't collide with real ids: workspace paths are absolute.
    expect(tabKind("/ws/agent:notes.md")).toBe("file");
    expect(isFileTabId("/ws/release:notes.md")).toBe(true);
  });
});
