import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useWorkspaceCommands,
  type WorkspaceCommands,
} from "@/hooks/use-workspace-commands";
import {
  registerTabController,
  unregisterTabController,
  type TabController,
} from "@/tabs/tab-controllers";

vi.mock("@/adapters", () => ({
  platformAdapter: { ui: { toggleFullscreen: vi.fn(async () => {}) } },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const openSearchPanel = vi.fn();
let commands: WorkspaceCommands;

function Probe({ activeTabId }: { activeTabId: string | null }) {
  commands = useWorkspaceCommands({
    workspacePath: "/ws",
    activeTabId,
    getFocusedTabId: () => activeTabId,
    getSelectedText: () => "beta",
    openSidebarIfCollapsed: () => {},
    setFileTreeMode: () => {},
    openSearchPanel,
    openSessionsSidebar: () => {},
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  openSearchPanel.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(activeTabId: string | null) {
  act(() => {
    root.render(createElement(Probe, { activeTabId }));
  });
}

describe("search in the active tab", () => {
  it("filters by file name on a file tab", () => {
    render("/ws/notes.md");

    act(() => commands.handleSearchInFile());

    expect(openSearchPanel).toHaveBeenCalledWith({
      filePattern: "notes.md",
      initialQuery: "beta",
    });
  });

  it("never turns a non-file tab id into a file filter", () => {
    render("agent:task_1");

    act(() => commands.handleSearchInFile());

    expect(openSearchPanel).toHaveBeenCalledWith({
      filePattern: undefined,
      initialQuery: "beta",
    });
  });

  it("searches the whole workspace with nothing open", () => {
    render(null);

    act(() => commands.handleSearchInFile());

    expect(openSearchPanel).toHaveBeenCalledWith({
      filePattern: undefined,
      initialQuery: "beta",
    });
  });
});

describe("undo/redo in the focused tab", () => {
  const undo = vi.fn();
  const redo = vi.fn();

  const controller: TabController = {
    tabId: "/ws/notes.md",
    kind: "file",
    focus: () => true,
    isFocusable: () => true,
    selectedText: () => undefined,
    dispose: () => {},
    search: () => [],
    revealMatch: () => false,
    history: { undo, redo },
  };

  beforeEach(() => {
    undo.mockClear();
    redo.mockClear();
  });

  afterEach(() => unregisterTabController("/ws/notes.md"));

  it("routes to the focused tab's own history", () => {
    registerTabController(controller);
    render("/ws/notes.md");

    act(() => commands.runHistoryAction("undo"));
    act(() => commands.runHistoryAction("redo"));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("is inert on a tab type with no history", () => {
    render("agent:task_1");

    expect(() => act(() => commands.runHistoryAction("undo"))).not.toThrow();
    expect(undo).not.toHaveBeenCalled();
  });
});
