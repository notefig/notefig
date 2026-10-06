import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { CoreProvider } from "@notefig/core/react";
import { createTestCore } from "@/testing/test-core";
import {
  useWorkspaceCommands,
  type WorkspaceCommands,
  type WorkspaceCommandsOptions,
} from "./use-workspace-commands";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function renderCommands(options: WorkspaceCommandsOptions): WorkspaceCommands {
  let commands: WorkspaceCommands | null = null;
  function Probe() {
    commands = useWorkspaceCommands(options);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      createElement(CoreProvider, {
        core: createTestCore(),
        children: createElement(Probe),
      }),
    ),
  );
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
