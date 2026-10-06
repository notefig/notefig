import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLayout } from "@/modules/layout";
import { createTabs, type TabsApi, type TabsDeps } from "@/modules/tabs";
import { memoryUrlState } from "@/testing/test-core";

const calls = vi.hoisted((): string[] => []);

const renameFileOrDirectoryMock = vi.fn();
/** The workspace's files the rename moves the file through. */
const files = {
  file: (from: string) => ({
    rename: (to: string) => {
      calls.push("rename-fs");
      return renameFileOrDirectoryMock(WS, from, to);
    },
  }),
} as never;

let cleanPromise: Promise<void> = Promise.resolve();
vi.mock("@/utils/markdown-conversion", () => ({
  flushDocumentSync: () => calls.push("flush"),
  whenDocumentSyncClean: () => {
    calls.push("capture-clean");
    return cleanPromise;
  },
}));

vi.mock("@/modules/tabs/tab-controllers", () => ({
  disposeTab: () => calls.push("dispose"),
  focusTab: vi.fn(),
  getTabController: vi.fn(),
  getTabSelectedText: vi.fn(),
  isTabFocusable: vi.fn(),
  revealTabMatch: vi.fn(),
  searchTab: vi.fn(),
  requestTabFocus: vi.fn(),
  grantTabFocusHandoff: vi.fn(),
}));

/** The live editor the rename freezes while the file moves. */
const liveEditor = {
  isDestroyed: false,
  setEditable: (editable: boolean) =>
    calls.push(editable ? "editable" : "readonly"),
};

/** What the documents module records of the move it is told about. */
const moves: { path: string; settledAt: string | null }[] = [];
const documents: TabsDeps["documents"] = {
  whenWritesSettled: () => {
    calls.push("writes-settled");
    return Promise.resolve();
  },
  beginMove: (path) => {
    const move = { path, settledAt: null as string | null };
    moves.push(move);
    return {
      settle(finalPath) {
        move.settledAt = finalPath;
      },
    };
  },
};

const WS = "/ws";
// Successful renames leave their stale-prune guard up until the layout
// commit clears it, so each test uses its own source path.
let pathCounter = 0;
let OLD = "";
let NEW = "";
let tabs: TabsApi;
let layoutWrites: [string, string][];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  moves.length = 0;
  cleanPromise = Promise.resolve();
  renameFileOrDirectoryMock.mockResolvedValue(undefined);
  pathCounter += 1;
  OLD = `/ws/.notefig/scratchpads/untitled-${pathCounter}.md`;
  NEW = `/ws/My Notes ${pathCounter}.md`;
  layoutWrites = [];
  const layout = createLayout(memoryUrlState());
  tabs = createTabs({
    layout,
    focusedWindow: { get: () => null, set: () => {}, subscribe: () => () => {} },
    canOpenFile: () => true,
    editors: {
      goTo: vi.fn(async () => true),
      markdownEditor: () => liveEditor as never,
    },
    documents,
  });
  // The layout swap itself is `tabs.rename`; record it where the real one
  // would write the layout (the tab is not in this test's layout).
  tabs.rename = (oldId, newId) => {
    calls.push("layout");
    layoutWrites.push([oldId, newId]);
  };
});

describe("tabs.renameOpenFile", () => {
  it("runs flush → drain → fs rename → dispose → layout swap, in order", async () => {
    await tabs.renameOpenFile({ files, oldPath: OLD, newPath: NEW });

    expect(calls).toEqual([
      "readonly",
      "flush",
      "capture-clean",
      "writes-settled",
      "rename-fs",
      "dispose",
      "layout",
    ]);
    expect(renameFileOrDirectoryMock).toHaveBeenCalledWith(WS, OLD, NEW);
    expect(layoutWrites).toEqual([[OLD, NEW]]);
  });

  it("tells documents where the file settled, so overlapping writes follow it", async () => {
    let resolveMove!: () => void;
    renameFileOrDirectoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveMove = resolve;
      }),
    );

    const run = tabs.renameOpenFile({ files, oldPath: OLD, newPath: NEW });
    expect(moves).toEqual([{ path: OLD, settledAt: null }]);

    resolveMove();
    await run;
    expect(moves[0].settledAt).toBe(NEW);
  });

  it("waits for the save pipeline to drain before moving the file", async () => {
    let resolveClean!: () => void;
    cleanPromise = new Promise((resolve) => {
      resolveClean = resolve;
    });

    const run = tabs.renameOpenFile({ files, oldPath: OLD, newPath: NEW });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renameFileOrDirectoryMock).not.toHaveBeenCalled();

    resolveClean();
    await run;
    expect(renameFileOrDirectoryMock).toHaveBeenCalled();
  });

  it("refuses a second rename of the same path while one is pending", async () => {
    let resolveMove!: () => void;
    renameFileOrDirectoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveMove = resolve;
      }),
    );

    const run = tabs.renameOpenFile({ files, oldPath: OLD, newPath: NEW });
    await expect(
      tabs.renameOpenFile({ files, oldPath: OLD, newPath: "/ws/other.md" }),
    ).rejects.toThrow(/already in progress/);
    // The refused call touched nothing: the first rename's move is intact
    // and it completes normally.
    expect(moves).toHaveLength(1);
    expect(tabs.renaming().get(OLD)).toBe(NEW);

    resolveMove();
    await run;
    expect(renameFileOrDirectoryMock).toHaveBeenCalledTimes(1);
    expect(moves[0].settledAt).toBe(NEW);
  });

  it("rethrows a failed move leaving the tab intact — no dispose, no layout write", async () => {
    renameFileOrDirectoryMock.mockRejectedValue(new Error("target exists"));

    await expect(
      tabs.renameOpenFile({ files, oldPath: OLD, newPath: NEW }),
    ).rejects.toThrow(/target exists/);
    expect(calls).not.toContain("dispose");
    // The frozen editor is thawed again — the tab stays fully usable.
    expect(calls).toEqual([
      "readonly",
      "flush",
      "capture-clean",
      "writes-settled",
      "rename-fs",
      "editable",
    ]);
    expect(layoutWrites).toEqual([]);
    // Writes that waited land on the original path, and the guard is down.
    expect(moves[0].settledAt).toBe(OLD);
    expect(tabs.renaming().size).toBe(0);
  });

  it("ends the stale-prune guard once the layout no longer holds the old id", async () => {
    const layout = createLayout(memoryUrlState());
    const live = createTabs({
      layout,
      focusedWindow: { get: () => null, set: () => {}, subscribe: () => () => {} },
      canOpenFile: () => true,
      editors: {
        goTo: vi.fn(async () => true),
        markdownEditor: () => undefined,
      },
      documents,
    });
    layout.update([
      { type: "Window", id: "w1", children: [OLD], selected: OLD } as never,
    ]);

    await live.renameOpenFile({ files, oldPath: OLD, newPath: NEW });
    // The swap is written; the layout holds the new id only.
    expect(layout.openTabIds()).toEqual([NEW]);
    expect(live.renaming().size).toBe(0);
  });
});

describe("the window in front", () => {
  /** Two windows side by side: a document left, a session's chat split off
   *  right — the user last focused the left one. */
  function splitLayout() {
    const layout = createLayout(memoryUrlState());
    let front: string | null = "left";
    const live = createTabs({
      layout,
      focusedWindow: {
        get: () => front,
        set: (id) => {
          front = id;
        },
        subscribe: () => () => {},
      },
      canOpenFile: () => true,
      editors: {
        goTo: vi.fn(async () => true),
        markdownEditor: () => undefined,
      },
      documents,
    });
    layout.update([
      {
        type: "Panel",
        id: "root",
        direction: "row",
        children: [
          { type: "Window", id: "left", children: ["/ws/a.md"], selected: "/ws/a.md" },
          { type: "Window", id: "right", children: ["agent:t1"], selected: "agent:t1" },
        ],
      } as never,
    ]);
    return live;
  }

  it("comes to the window of a tab opened where it already lives", () => {
    const live = splitLayout();
    expect(live.activeTabId()).toBe("/ws/a.md");
    live.openAgent("t1");
    expect(live.activeWindowId()).toBe("right");
    expect(live.activeTabId()).toBe("agent:t1");
  });

  it("comes to the window of a selected tab", () => {
    const live = splitLayout();
    live.select("agent:t1");
    expect(live.activeTabId()).toBe("agent:t1");
  });

  it("wins over DOM focus left in the other window", () => {
    const live = splitLayout();
    // An editor in the left pane keeps focus while it opens a link to the
    // chat already open on the right (LinkBubbleMenu preserves focus).
    const left = document.createElement("div");
    left.setAttribute("data-dockable-window-id", "left");
    const input = document.createElement("input");
    left.appendChild(input);
    document.body.appendChild(left);
    input.focus();
    try {
      expect(live.activeWindowId()).toBe("left");
      live.openAgent("t1");
      expect(live.activeWindowId()).toBe("right");
      expect(live.activeTabId()).toBe("agent:t1");
    } finally {
      left.remove();
    }
  });
});
