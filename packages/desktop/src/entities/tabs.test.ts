import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const renameFileOrDirectoryMock = vi.fn();
vi.mock("@/entities/files", () => ({
  useOpenFileRows: vi.fn(() => []),
  useMetadataFetching: vi.fn(() => false),
  renameFileOrDirectory: (ws: string, from: string, to: string) => {
    calls.push("rename-fs");
    return renameFileOrDirectoryMock(ws, from, to);
  },
}));

let cleanPromise: Promise<void> = Promise.resolve();
vi.mock("@/utils/markdown-conversion", () => ({
  flushDocumentSync: () => calls.push("flush"),
  whenDocumentSyncClean: () => {
    calls.push("capture-clean");
    return cleanPromise;
  },
}));

vi.mock("@/tabs/tab-controllers", () => ({
  disposeTab: () => calls.push("dispose"),
  focusTab: vi.fn(),
  getTabController: vi.fn(),
  getTabSelectedText: vi.fn(),
  isTabFocusable: vi.fn(),
  revealTabMatch: vi.fn(),
  searchTab: vi.fn(),
}));

vi.mock("./editors", () => ({ editor: vi.fn() }));

const liveEditor = {
  isDestroyed: false,
  setEditable: vi.fn((editable: boolean) =>
    calls.push(editable ? "editable" : "readonly"),
  ),
};
vi.mock("@/components/editor/editor-store", () => ({
  getMarkdownEditor: () => liveEditor,
}));

vi.mock("@/utils/workspace-write-tracker", () => ({
  whenWorkspaceWritesSettled: () => {
    calls.push("writes-settled");
    return Promise.resolve();
  },
}));
vi.mock("./agents", () => ({
  agents: { task: vi.fn() },
  agentTasksCollection: { get: vi.fn() },
  useAgentTasksReady: vi.fn(() => true),
  useAgentTaskRowsById: vi.fn(() => []),
}));

import { activeRenameTarget, renameOpenFileTab } from "./tabs";

const WS = "/ws";
// Successful renames leave their stale-prune guard up until the layout
// commit clears it (a hook effect these tests never run), so each test
// uses its own source path.
let pathCounter = 0;
let OLD = "";
let NEW = "";

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  cleanPromise = Promise.resolve();
  renameFileOrDirectoryMock.mockResolvedValue(undefined);
  pathCounter += 1;
  OLD = `/ws/.metrists/scratchpads/untitled-${pathCounter}.md`;
  NEW = `/ws/My Notes ${pathCounter}.md`;
});

describe("renameOpenFileTab", () => {
  it("runs flush → drain → fs rename → dispose → layout swap, in order", async () => {
    const applyLayoutRename = vi.fn(() => calls.push("layout"));

    await renameOpenFileTab({
      workspacePath: WS,
      oldPath: OLD,
      newPath: NEW,
      applyLayoutRename,
    });

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
    expect(applyLayoutRename).toHaveBeenCalledWith(OLD, NEW);
  });

  it("redirects overlapping programmatic writes to the settled path", async () => {
    let resolveMove!: () => void;
    renameFileOrDirectoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveMove = resolve;
      }),
    );

    const run = renameOpenFileTab({
      workspacePath: WS,
      oldPath: OLD,
      newPath: NEW,
      applyLayoutRename: vi.fn(),
    });
    const target = activeRenameTarget(OLD);
    expect(target).not.toBeNull();

    resolveMove();
    await run;
    await expect(target).resolves.toBe(NEW);
    expect(activeRenameTarget(OLD)).toBeNull();
  });

  it("waits for the save pipeline to drain before moving the file", async () => {
    let resolveClean!: () => void;
    cleanPromise = new Promise((resolve) => {
      resolveClean = resolve;
    });
    const applyLayoutRename = vi.fn();

    const run = renameOpenFileTab({
      workspacePath: WS,
      oldPath: OLD,
      newPath: NEW,
      applyLayoutRename,
    });
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

    const run = renameOpenFileTab({
      workspacePath: WS,
      oldPath: OLD,
      newPath: NEW,
      applyLayoutRename: vi.fn(),
    });
    await expect(
      renameOpenFileTab({
        workspacePath: WS,
        oldPath: OLD,
        newPath: "/ws/other.md",
        applyLayoutRename: vi.fn(),
      }),
    ).rejects.toThrow(/already in progress/);
    // The refused call touched nothing: the first rename's write redirect
    // is intact and it completes normally.
    expect(activeRenameTarget(OLD)).not.toBeNull();

    resolveMove();
    await run;
    expect(renameFileOrDirectoryMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed move leaving the tab intact — no dispose, no layout write", async () => {
    renameFileOrDirectoryMock.mockRejectedValue(new Error("target exists"));
    const applyLayoutRename = vi.fn();

    await expect(
      renameOpenFileTab({
        workspacePath: WS,
        oldPath: OLD,
        newPath: NEW,
        applyLayoutRename,
      }),
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
    expect(applyLayoutRename).not.toHaveBeenCalled();
  });
});
