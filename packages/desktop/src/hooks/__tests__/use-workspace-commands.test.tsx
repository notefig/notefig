import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useWorkspaceCommands,
  type WorkspaceCommands,
} from "@/hooks/use-workspace-commands";

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
});
