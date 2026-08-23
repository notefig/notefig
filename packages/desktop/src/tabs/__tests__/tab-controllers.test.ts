import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeTab,
  focusTab,
  getTabSelectedText,
  hasTabController,
  registerTabController,
  runTabHistoryAction,
  searchTab,
  setActiveTab,
  unregisterTabController,
  type TabController,
} from "../tab-controllers";

function stubController(
  tabId: string,
  overrides: Partial<TabController> = {},
): TabController {
  return {
    tabId,
    kind: "file",
    focus: () => true,
    isFocusable: () => true,
    selectedText: () => "selected",
    dispose: () => {},
    search: async () => [],
    revealMatch: () => true,
    ...overrides,
  };
}

afterEach(() => {
  unregisterTabController("/ws/a.md");
  unregisterTabController("agent:task_1");
  setActiveTab(null);
});

describe("tab controller registry", () => {
  it("dispatches the general ops to whichever tab type is registered", () => {
    registerTabController(
      stubController("agent:task_1", {
        kind: "agent",
        selectedText: () => "from the transcript",
      }),
    );

    expect(getTabSelectedText("agent:task_1")).toBe("from the transcript");
    expect(runTabHistoryAction("agent:task_1", "undo")).toBeUndefined();
  });

  it("no-ops on a tab with no live controller", async () => {
    expect(getTabSelectedText("/ws/closed.md")).toBeUndefined();
    await expect(searchTab("/ws/closed.md", "x")).resolves.toEqual([]);
    expect(focusTab("/ws/closed.md")).toBe(false);
    expect(() => disposeTab("/ws/closed.md")).not.toThrow();
  });

  it("disposes once and drops the entry", () => {
    const dispose = vi.fn();
    registerTabController(stubController("/ws/a.md", { dispose }));

    disposeTab("/ws/a.md");
    disposeTab("/ws/a.md");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(hasTabController("/ws/a.md")).toBe(false);
  });

  it("focuses only the active tab — a background tab's intent waits", () => {
    const focus = vi.fn(() => true);
    registerTabController(stubController("/ws/a.md", { focus }));

    setActiveTab("agent:task_1");
    expect(focusTab("/ws/a.md")).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    setActiveTab("/ws/a.md");
    expect(focusTab("/ws/a.md")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
