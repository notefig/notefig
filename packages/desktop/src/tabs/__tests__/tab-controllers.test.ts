import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeTab,
  focusTab,
  getTabController,
  getTabSelectedText,
  hasTabController,
  isTabFocusable,
  registerTabController,
  revealTabMatch,
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
    search: () => [{ matchText: "a", lineText: "a b", occurrence: 0 }],
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
  it("publishes and withdraws a tab's controls", () => {
    expect(hasTabController("/ws/a.md")).toBe(false);

    registerTabController(stubController("/ws/a.md"));
    expect(getTabController("/ws/a.md")?.kind).toBe("file");

    unregisterTabController("/ws/a.md");
    expect(hasTabController("/ws/a.md")).toBe(false);
  });

  it("dispatches the general ops to whichever tab type is registered", () => {
    registerTabController(
      stubController("agent:task_1", {
        kind: "agent",
        selectedText: () => "from the transcript",
        search: () => [],
        revealMatch: () => false,
      }),
    );

    expect(getTabSelectedText("agent:task_1")).toBe("from the transcript");
    expect(isTabFocusable("agent:task_1")).toBe(true);
    expect(searchTab("agent:task_1", "x")).toEqual([]);
    expect(
      revealTabMatch("agent:task_1", {
        matchText: "x",
        lineText: "x",
        occurrence: 0,
      }),
    ).toBe(false);
  });

  it("no-ops on a tab with no live controller", () => {
    expect(getTabSelectedText("/ws/closed.md")).toBeUndefined();
    expect(isTabFocusable("/ws/closed.md")).toBe(false);
    expect(searchTab("/ws/closed.md", "x")).toEqual([]);
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

  it("routes history actions only when the tab type has a history", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerTabController(
      stubController("/ws/a.md", { history: { undo, redo } }),
    );

    runTabHistoryAction("/ws/a.md", "undo");
    runTabHistoryAction("/ws/a.md", "redo");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);

    registerTabController(stubController("agent:task_1", { kind: "agent" }));
    expect(() => runTabHistoryAction("agent:task_1", "undo")).not.toThrow();
  });
});

describe("focusTab", () => {
  it("reports the controller's own outcome, synchronously", () => {
    const focus = vi.fn(() => true);
    registerTabController(stubController("/ws/a.md", { focus }));
    setActiveTab("/ws/a.md");

    expect(focusTab("/ws/a.md")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("declines when the tab's surface refuses focus", () => {
    registerTabController(stubController("/ws/a.md", { focus: () => false }));
    setActiveTab("/ws/a.md");

    expect(focusTab("/ws/a.md")).toBe(false);
  });

  it("only focuses the active tab — a background tab's intent waits", () => {
    const focus = vi.fn(() => true);
    registerTabController(stubController("/ws/a.md", { focus }));
    setActiveTab("agent:task_1");

    expect(focusTab("/ws/a.md")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
