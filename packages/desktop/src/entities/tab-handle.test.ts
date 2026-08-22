import { afterEach, describe, expect, it, vi } from "vitest";
import { tab } from "./tabs";
import {
  registerTabController,
  unregisterTabController,
  setActiveTab,
  type TabController,
} from "@/tabs/tab-controllers";

const FILE_TAB = "/ws/notes.md";
const AGENT_TAB = "agent:task_1";

function stubController(
  tabId: string,
  overrides: Partial<TabController> = {},
): TabController {
  return {
    tabId,
    kind: "file",
    focus: () => true,
    isFocusable: () => true,
    selectedText: () => undefined,
    dispose: () => {},
    search: () => [],
    revealMatch: () => false,
    ...overrides,
  };
}

afterEach(() => {
  unregisterTabController(FILE_TAB);
  unregisterTabController(AGENT_TAB);
  setActiveTab(null);
});

describe("tab()", () => {
  it("exposes the file tab's document controls under .editor", () => {
    const handle = tab(FILE_TAB);
    if (handle.kind !== "file") throw new Error("expected a file tab");

    expect(handle.path).toBe(FILE_TAB);
    expect(handle.editor.filePath).toBe(FILE_TAB);
    // No live editor for this path — the handle reads through, it doesn't
    // cache, so it simply reports an unmounted document.
    expect(handle.editor.isMounted()).toBe(false);
  });

  it("exposes the agent tab's session controls under .agent", () => {
    const handle = tab(AGENT_TAB);
    if (handle.kind !== "agent") throw new Error("expected an agent tab");

    expect(handle.taskId).toBe("task_1");
    expect(handle.agent.taskId).toBe("task_1");
  });

  it("gives every kind the same general controls", () => {
    const selectedText = vi.fn(() => "picked");
    registerTabController(
      stubController(AGENT_TAB, { kind: "agent", selectedText }),
    );
    setActiveTab(AGENT_TAB);

    const handle = tab(AGENT_TAB);
    expect(handle.isMounted()).toBe(true);
    expect(handle.isFocusable()).toBe(true);
    expect(handle.selectedText()).toBe("picked");
    expect(handle.focus()).toBe(true);
  });

  it("is inert on a tab whose surface isn't live", () => {
    const handle = tab(FILE_TAB);

    expect(handle.isMounted()).toBe(false);
    expect(handle.focus()).toBe(false);
    expect(handle.selectedText()).toBeUndefined();
    expect(handle.search("anything")).toEqual([]);
  });
});
