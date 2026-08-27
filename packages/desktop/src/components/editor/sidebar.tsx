import { useState, useEffect, useRef, useCallback, type Ref } from "react";
import { useSearchParams } from "react-router-dom";
import { FileTree, type FileTreeMode } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import {
  SearchPanel,
  type SearchPanelHandle,
} from "@/components/editor/search-panel";
import { SessionsPanel } from "@/components/agent/sessions-panel";
import { CheckpointPanel } from "@/components/editor/git/checkpoint-panel";
import {
  useFileCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  createFile,
  createDirectory,
} from "@/entities/files";
import {
  ensureNewFileNameHasDefaultMarkdownExtension,
  getDirectoryPath,
  isTextFile,
} from "@/utils/fs";
import type { FileTreeNode, SortOrder } from "@/utils/fs";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { requestElementFocus } from "@/utils/focus-arbiter";
import { createAndOpenScratchpad } from "@/entities/scratchpads";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";

interface SidebarProps {
  workspacePath: string;
  activeTabId: string | null;
  openTabs: string[];
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  closeTab: (tabId: string, options?: { runBeforeClose?: boolean }) => void;
  /** Rename/move a file whose tab is open (close-and-reopen primitive). */
  onRenameOpenFile: (oldPath: string, newPath: string) => Promise<void>;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
  searchPanelRef?: Ref<SearchPanelHandle>;
}

export function Sidebar({
  workspacePath,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  onRenameOpenFile,
  mode,
  onModeChange,
  searchPanelRef,
}: SidebarProps) {
  const { metadata } = useFileCollections(workspacePath);

  const [searchParams, setUrlSearchParams] = useSearchParams();
  const sortOrder = (searchParams.get("sort") as SortOrder) || "name-asc";
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setUrlSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (order === "name-asc") {
          next.delete("sort");
        } else {
          next.set("sort", order);
        }
        return next;
      });
    },
    [setUrlSearchParams],
  );

  // Widths in rem so they track the root font-size (app-wide UI scale).
  const SIDEBAR_DEFAULT_REM = 15;
  const SIDEBAR_MIN_REM = 9.375;
  const SIDEBAR_MAX_REM = 25;
  // Must match the icon rail's w-9 (2.25rem) in icon-sidebar.tsx.
  const ICON_SIDEBAR_REM = 2.25;

  const [sidebarWidth, setSidebarWidth] = useState(`${SIDEBAR_DEFAULT_REM}rem`);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const remPx = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const newWidthRem = (e.clientX - ICON_SIDEBAR_REM * remPx) / remPx;
      const clampedRem = Math.max(
        SIDEBAR_MIN_REM,
        Math.min(SIDEBAR_MAX_REM, newWidthRem),
      );
      setSidebarWidth(`${clampedRem}rem`);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (mode.type !== "idle") return;

    requestElementFocus("sidebar-first-file-item", {
      domain: "sidebar",
      priority: 60,
      reason: "sidebar-open-focus-first-item",
      when: "when-mounted",
    });
  }, [mode.type]);

  const { openFile } = useWorkspaceTabs();

  // "New File" is instant and nameless (a scratchpad); location-specific
  // creation stays on the tree's per-folder context menu (handleCreate).
  const handleNewFile = useCallback(() => {
    createAndOpenScratchpad(workspacePath, openFile);
  }, [workspacePath, openFile]);

  const handleNewFolder = useCallback(() => {
    onModeChange({
      type: "creating",
      parentPath: workspacePath,
      itemType: "directory",
    });
  }, [workspacePath, onModeChange]);

  const handleCreate = useCallback(
    (parentPath: string, name: string, type: "file" | "directory") => {
      const resolvedName =
        type === "file"
          ? ensureNewFileNameHasDefaultMarkdownExtension(name)
          : name;
      const fullPath = parentPath + "/" + resolvedName;

      const existing = metadata.get(fullPath);
      if (existing) {
        console.error(`Cannot create: "${fullPath}" already exists`);
        return;
      }

      if (type === "file") {
        createFile(workspacePath, fullPath)
          .then(() => {
            if (isTextFile(fullPath)) {
              onFileSelect({
                path: fullPath,
                type: "file",
                contentHash: "",
                content: "",
              });
            }
          })
          .catch((error: unknown) => {
            console.error(`Failed to create file ${fullPath}:`, error);
          });
      } else {
        createDirectory(workspacePath, fullPath).catch((error: unknown) => {
          console.error(`Failed to create directory ${fullPath}:`, error);
        });
      }
    },
    [workspacePath, metadata, onFileSelect],
  );

  const handleDeleteFile = useCallback(
    (path: string) => {
      const pathPrefix = path.endsWith("/") ? path : path + "/";
      for (const tabId of openTabs) {
        if (tabId === path || tabId.startsWith(pathPrefix)) {
          // Part of a deletion: the close lifecycle (scratchpad GC
          // rename/delete) must not race the delete below.
          closeTab(tabId, { runBeforeClose: false });
        }
      }

      deleteFileOrDirectory(workspacePath, path).catch((error: unknown) => {
        console.error(`Failed to delete ${path}:`, error);
      });
    },
    [openTabs, closeTab, workspacePath],
  );

  const handleRenameFile = useCallback(
    (oldPath: string, newName: string) => {
      // Rename is always in place — moving a scratchpad OUT of its folder
      // (promotion) is the drag gesture, never a rename side effect.
      const newPath = getDirectoryPath(oldPath) + "/" + newName;
      if (oldPath === newPath) return;

      const existing = metadata.get(newPath);
      if (existing) {
        console.error(`Cannot rename: "${newPath}" already exists`);
        return;
      }

      // Scratchpads may be renamed while open — route through the
      // close-and-reopen primitive so the tab follows the file.
      const rename = openTabs.includes(oldPath)
        ? onRenameOpenFile(oldPath, newPath)
        : renameFileOrDirectory(workspacePath, oldPath, newPath);
      rename.catch((error: unknown) => {
        console.error(`Failed to rename ${oldPath} to ${newPath}:`, error);
      });
    },
    [workspacePath, metadata, openTabs, onRenameOpenFile],
  );

  const sidebarView = searchParams.get("sidebarView") || "files";

  return (
    <>
      <div
        ref={containerRef}
        data-sidebar
        className="shrink-0 bg-sidebar flex flex-col-reverse border-border min-h-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {sidebarView === "search" ? (
          <SearchPanel ref={searchPanelRef} workspacePath={workspacePath} />
        ) : sidebarView === "git" ? (
          <CheckpointPanel workspacePath={workspacePath} />
        ) : sidebarView === "sessions" ? (
          <SessionsPanel
            workspacePath={workspacePath}
            activeTabId={activeTabId}
          />
        ) : (
          <>
            <FileTree
              selectedFilePath={activeTabId}
              onFileSelect={onFileSelect}
              onDelete={handleDeleteFile}
              onRename={handleRenameFile}
              onRenameOpenFile={onRenameOpenFile}
              onCreate={handleCreate}
              openTabs={openTabs}
              basePath={workspacePath}
              sortOrder={sortOrder}
              mode={mode}
              onModeChange={onModeChange}
            />
            <FileControls
              onNewFile={handleNewFile}
              onNewFolder={handleNewFolder}
              sortOrder={sortOrder}
              onSortChange={setSortOrder}
            />
          </>
        )}
      </div>
      <div
        ref={resizeRef}
        onMouseDown={handleResizeStart}
        className="w-0.5 shrink-0 bg-transparent hover:bg-primary/50 cursor-col-resize transition-colors"
      />
    </>
  );
}
