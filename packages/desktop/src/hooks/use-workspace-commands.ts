import { useCallback } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { platformAdapter } from "@/adapters";
import { getFileName } from "@/utils/fs";
import { runTabHistoryAction } from "@/tabs/tab-controllers";
import { tabKind } from "@/tabs/tab-id";
import type { FileTreeMode } from "@/components/editor/file-tree";

export interface WorkspaceCommandsOptions {
  workspacePath: string;
  activeTabId: string | null;
  getFocusedTabId: () => string | null;
  getSelectedText: () => string | undefined;
  /** Expand the sidebar if collapsed (file creation lands in the tree). */
  openSidebarIfCollapsed: () => void;
  setFileTreeMode: (mode: FileTreeMode) => void;
  openSearchPanel: (options?: {
    filePattern?: string;
    initialQuery?: string;
  }) => void;
  openSessionsSidebar: () => void;
}

export interface WorkspaceCommands {
  handleNewFile: () => void;
  handleNewDirectory: () => void;
  /** Undo/redo inside the focused tab, if its type keeps a history. */
  runHistoryAction: (action: "undo" | "redo") => void;
  handleToggleFullscreen: () => void;
  handleSearchInFile: () => void;
  handleSearchInFiles: () => void;
}

/**
 * The workspace's command handlers (fed to CommandPalette) and their
 * keyboard shortcuts: Mod+N new file, Mod+F search in file, Mod+Shift+F
 * global search, Mod+Shift+A agent sessions sidebar.
 */
export function useWorkspaceCommands({
  workspacePath,
  activeTabId,
  getFocusedTabId,
  getSelectedText,
  openSidebarIfCollapsed,
  setFileTreeMode,
  openSearchPanel,
  openSessionsSidebar,
}: WorkspaceCommandsOptions): WorkspaceCommands {
  const handleNewFile = useCallback(() => {
    openSidebarIfCollapsed();
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "file",
    });
  }, [workspacePath, openSidebarIfCollapsed, setFileTreeMode]);

  const handleNewDirectory = useCallback(() => {
    openSidebarIfCollapsed();
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "directory",
    });
  }, [workspacePath, openSidebarIfCollapsed, setFileTreeMode]);

  const runHistoryAction = useCallback(
    (action: "undo" | "redo") => {
      const focusedTabId = getFocusedTabId();
      if (!focusedTabId) return;
      runTabHistoryAction(focusedTabId, action);
    },
    [getFocusedTabId],
  );

  const handleToggleFullscreen = useCallback(() => {
    platformAdapter.ui.toggleFullscreen().catch((error: unknown) => {
      console.error("Failed to toggle fullscreen:", error);
    });
  }, []);

  /**
   * Mod+F — search within the active tab. The file filter only means
   * something for a file tab; on any other kind (an agent session, the
   * release notes) this falls back to an unfiltered search, seeded with
   * whatever is selected in that tab.
   */
  const handleSearchInFile = useCallback(() => {
    const selectedText = getSelectedText();
    const searchableFile =
      activeTabId && tabKind(activeTabId) === "file" ? activeTabId : null;

    openSearchPanel({
      filePattern: searchableFile ? getFileName(searchableFile) : undefined,
      initialQuery: selectedText,
    });
  }, [activeTabId, getSelectedText, openSearchPanel]);

  /** Mod+Shift+F — global search across all files */
  const handleSearchInFiles = useCallback(() => {
    const selectedText = getSelectedText();

    openSearchPanel({ initialQuery: selectedText });
  }, [getSelectedText, openSearchPanel]);

  useHotkey("Mod+N", () => {
    handleNewFile();
  });

  useHotkey("Mod+F", () => {
    handleSearchInFile();
  });

  useHotkey("Mod+Shift+F", () => {
    handleSearchInFiles();
  });

  useHotkey("Mod+Shift+A", () => {
    openSessionsSidebar();
  });

  return {
    handleNewFile,
    handleNewDirectory,
    runHistoryAction,
    handleToggleFullscreen,
    handleSearchInFile,
    handleSearchInFiles,
  };
}
