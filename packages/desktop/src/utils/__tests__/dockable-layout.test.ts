import { describe, expect, it } from "vitest";
import type { LayoutNode } from "@/components/dockable";
import {
  addTabToLayout,
  createInitialLayout,
  findWindowContainingTab,
  openFileInLayout,
  openTabInWindow,
  removeTabFromLayout,
  renameTabInLayout,
  replaceSelectedTabInWindow,
  resolveTargetWindowId,
} from "../dockable-layout";

function makeTwoWindowLayout(): LayoutNode[] {
  return [
    {
      type: "Panel",
      id: "panel-root",
      orientation: "row",
      children: [
        {
          type: "Window",
          id: "window-left",
          children: ["a.md", "b.md"],
          selected: "b.md",
          size: 0.5,
        },
        {
          type: "Window",
          id: "window-right",
          children: ["c.md"],
          selected: "c.md",
          size: 0.5,
        },
      ],
      size: 1,
    },
  ];
}

describe("renameTabInLayout", () => {
  it("swaps the id in place, preserving index and window membership", () => {
    const layout = renameTabInLayout(makeTwoWindowLayout(), "a.md", "z.md");
    const panel = layout[0];
    if (panel.type !== "Panel") throw new Error("expected panel");
    const left = panel.children[0];
    if (left.type !== "Window") throw new Error("expected window");
    expect(left.children).toEqual(["z.md", "b.md"]);
    expect(left.selected).toBe("b.md");
  });

  it("moves selection with a selected tab", () => {
    const layout = renameTabInLayout(makeTwoWindowLayout(), "b.md", "y.md");
    const panel = layout[0];
    if (panel.type !== "Panel") throw new Error("expected panel");
    const left = panel.children[0];
    if (left.type !== "Window") throw new Error("expected window");
    expect(left.children).toEqual(["a.md", "y.md"]);
    expect(left.selected).toBe("y.md");
  });

  it("leaves other windows untouched and is a no-op for absent ids", () => {
    const original = makeTwoWindowLayout();
    const renamed = renameTabInLayout(original, "c.md", "x.md");
    const untouched = renameTabInLayout(original, "missing.md", "x.md");
    const panel = renamed[0];
    if (panel.type !== "Panel") throw new Error("expected panel");
    const right = panel.children[1];
    if (right.type !== "Window") throw new Error("expected window");
    expect(right.children).toEqual(["x.md"]);
    expect(right.selected).toBe("x.md");
    expect(untouched).toEqual(original);
  });
});

describe("dockable-layout", () => {
  it("creates initial layout for first tab", () => {
    const layout = createInitialLayout("first.md");
    expect(layout).toEqual([
      {
        type: "Window",
        id: "editor-window",
        children: ["first.md"],
        selected: "first.md",
        size: 1,
      },
    ]);
  });

  it("finds a window that contains a tab", () => {
    const layout = makeTwoWindowLayout();
    const windowNode = findWindowContainingTab(layout, "c.md");
    expect(windowNode?.id).toBe("window-right");
  });

  it("resolves target window with fallback", () => {
    const layout = makeTwoWindowLayout();

    expect(resolveTargetWindowId(layout, "window-right")).toBe("window-right");
    expect(resolveTargetWindowId(layout, "missing-window")).toBe("window-left");
  });

  it("replaces selected tab in a target window", () => {
    const layout = makeTwoWindowLayout();
    const next = replaceSelectedTabInWindow(layout, "window-left", "x.md");
    const left = findWindowContainingTab(next, "x.md");

    expect(left?.children).toEqual(["a.md", "x.md"]);
    expect(left?.selected).toBe("x.md");
    expect(findWindowContainingTab(next, "b.md")).toBeNull();
  });

  it("opens tab in window in new-tab mode", () => {
    const layout = makeTwoWindowLayout();
    const next = openTabInWindow(layout, "window-right", "d.md", "new-tab");
    const right = findWindowContainingTab(next, "d.md");

    expect(right?.children).toEqual(["c.md", "d.md"]);
    expect(right?.selected).toBe("d.md");
  });

  it("opens tab in window in replace mode", () => {
    const layout = makeTwoWindowLayout();
    const next = openTabInWindow(layout, "window-right", "d.md", "replace");
    const right = findWindowContainingTab(next, "d.md");

    expect(right?.children).toEqual(["d.md"]);
    expect(right?.selected).toBe("d.md");
    expect(findWindowContainingTab(next, "c.md")).toBeNull();
  });

  it("openFileInLayout creates initial layout when empty", () => {
    const next = openFileInLayout([], { tabId: "a.md", intent: "replace" });
    expect(next).toEqual(createInitialLayout("a.md"));
  });

  it("openFileInLayout replaces selected tab by default intent", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "new.md",
      intent: "replace",
      targetWindowId: "window-left",
    });

    const left = findWindowContainingTab(next, "new.md");
    expect(left?.children).toEqual(["a.md", "new.md"]);
    expect(left?.selected).toBe("new.md");
  });

  it("openFileInLayout appends when intent is new-tab", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "new.md",
      intent: "new-tab",
      targetWindowId: "window-left",
    });

    const left = findWindowContainingTab(next, "new.md");
    expect(left?.children).toEqual(["a.md", "b.md", "new.md"]);
    expect(left?.selected).toBe("new.md");
  });

  it("openFileInLayout focuses existing tab and avoids duplicates", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "a.md",
      intent: "new-tab",
      targetWindowId: "window-right",
    });

    const left = findWindowContainingTab(next, "a.md");
    expect(left?.children.filter((id) => id === "a.md")).toEqual(["a.md"]);
    expect(left?.selected).toBe("a.md");
    expect(findWindowContainingTab(next, "b.md")?.selected).toBe("a.md");
  });

  it("openFileInLayout with moveIfOpen relocates an open tab to the target window", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "a.md",
      intent: "new-tab",
      targetWindowId: "window-right",
      moveIfOpen: true,
    });

    const right = findWindowContainingTab(next, "a.md");
    expect(right?.id).toBe("window-right");
    expect(right?.children).toEqual(["c.md", "a.md"]);
    expect(right?.selected).toBe("a.md");
    // gone from the source window
    expect(findWindowContainingTab(next, "b.md")?.children).toEqual(["b.md"]);
  });

  it("openFileInLayout with moveIfOpen collapses an emptied source window", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "c.md",
      intent: "new-tab",
      targetWindowId: "window-left",
      moveIfOpen: true,
    });

    expect(findWindowContainingTab(next, "c.md")?.id).toBe("window-left");
    // window-right had only c.md — it should be gone entirely
    expect(resolveTargetWindowId(next, "window-right")).not.toBe(
      "window-right",
    );
  });

  it("openFileInLayout with moveIfOpen and same window just selects", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "a.md",
      intent: "new-tab",
      targetWindowId: "window-left",
      moveIfOpen: true,
    });

    const left = findWindowContainingTab(next, "a.md");
    expect(left?.id).toBe("window-left");
    expect(left?.children).toEqual(["a.md", "b.md"]);
    expect(left?.selected).toBe("a.md");
  });

  // Agent chat tabs ride the same layout with `agent:<taskId>` ids — the
  // transforms must stay id-agnostic.
  it("opens an agent tab id alongside file tabs and dedupes on reopen", () => {
    const layout = makeTwoWindowLayout();
    const opened = openFileInLayout(layout, {
      tabId: "agent:task_1",
      intent: "new-tab",
      targetWindowId: "window-left",
    });
    const left = findWindowContainingTab(opened, "agent:task_1");
    expect(left?.children).toEqual(["a.md", "b.md", "agent:task_1"]);
    expect(left?.selected).toBe("agent:task_1");

    // Reopening selects the existing tab instead of duplicating it.
    const reopened = openFileInLayout(opened, {
      tabId: "agent:task_1",
      intent: "new-tab",
      targetWindowId: "window-right",
    });
    const stillLeft = findWindowContainingTab(reopened, "agent:task_1");
    expect(stillLeft?.id).toBe("window-left");
    expect(
      stillLeft?.children.filter((id) => id === "agent:task_1"),
    ).toEqual(["agent:task_1"]);
  });

  it("removing a window's only agent tab collapses the window", () => {
    const layout: LayoutNode[] = [
      {
        type: "Panel",
        id: "panel-root",
        orientation: "row",
        children: [
          {
            type: "Window",
            id: "window-left",
            children: ["a.md"],
            selected: "a.md",
            size: 0.5,
          },
          {
            type: "Window",
            id: "window-right",
            children: ["agent:task_1"],
            selected: "agent:task_1",
            size: 0.5,
          },
        ],
        size: 1,
      },
    ];
    const next = removeTabFromLayout(layout, "agent:task_1");
    expect(findWindowContainingTab(next, "agent:task_1")).toBeNull();
    expect(resolveTargetWindowId(next, "window-right")).not.toBe(
      "window-right",
    );
    expect(findWindowContainingTab(next, "a.md")).not.toBeNull();
  });

  it("openFileInLayout without moveIfOpen selects in place (active-window fallback safety)", () => {
    const layout = makeTwoWindowLayout();
    const next = openFileInLayout(layout, {
      tabId: "a.md",
      intent: "new-tab",
      targetWindowId: "window-right",
    });

    expect(findWindowContainingTab(next, "a.md")?.id).toBe("window-left");
  });

  it("addTabToLayout appends to first window", () => {
    const layout = makeTwoWindowLayout();
    const next = addTabToLayout(layout, "x.md");
    const left = findWindowContainingTab(next, "x.md");

    expect(left?.id).toBe("window-left");
    expect(left?.children).toEqual(["a.md", "b.md", "x.md"]);
    expect(left?.selected).toBe("x.md");
  });

  it("removeTabFromLayout removes empty windows", () => {
    const layout = createInitialLayout("only.md");
    const next = removeTabFromLayout(layout, "only.md");
    expect(next).toEqual([]);
  });
});
