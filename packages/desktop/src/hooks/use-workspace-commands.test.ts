import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/adapters", () => ({ platformAdapter: {} }));
vi.mock("@/entities/scratchpads", () => ({ createAndOpenScratchpad: vi.fn() }));

import {
  useWorkspaceCommands,
  type WorkspaceCommands,
  type WorkspaceCommandsOptions,
} from "./use-workspace-commands";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function renderCommands(options: WorkspaceCommandsOptions): WorkspaceCommands {
  let commands: WorkspaceCommands | null = null;
  function Probe() {
    commands = useWorkspaceCommands(options);
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return commands!;
}

function options(): WorkspaceCommandsOptions {
  return {
    workspacePath: "/ws",
    activeTabId: null,
    getFocusedTabId: () => null,
    getSelectedText: () => undefined,
    showFileTree: vi.fn(),
    setFileTreeMode: vi.fn(),
    openFile: vi.fn(() => true),
    openSearchPanel: vi.fn(),
    openSessionsSidebar: vi.fn(),
  };
}

describe("new file / new folder from the palette", () => {
  it.each([
    ["handleNewFile", "file"],
    ["handleNewDirectory", "directory"],
  ] as const)(
    "%s shows the file tree and starts its inline naming",
    (handler, itemType) => {
      const opts = options();
      renderCommands(opts)[handler]();
      // The tree is where the name input lives: the Files view, not just an
      // expanded sidebar (which may be on Everything, with no tree mounted).
      expect(opts.showFileTree).toHaveBeenCalledOnce();
      expect(opts.setFileTreeMode).toHaveBeenCalledWith({
        type: "creating",
        parentPath: "/ws",
        itemType,
      });
    },
  );
});
