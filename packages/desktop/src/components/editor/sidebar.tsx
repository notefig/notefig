import { useState, useEffect, useRef, useCallback, type Ref } from "react";
import { useSearchParams } from "react-router-dom";
import { FileTree, type FileTreeMode } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import {
  SearchPanel,
  type SearchPanelHandle,
} from "@/components/editor/search-panel";
import { CheckpointPanel } from "@/components/editor/git/checkpoint-panel";
import {
  getOrCreateWorkspaceCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  createFile,
  createDirectory,
} from "@/utils/collections";
import {
  ensureNewFileNameHasDefaultMarkdownExtension,
  getDirectoryPath,
  isTextFile,
} from "@/utils/fs";
import type { FileTreeNode, SortOrder } from "@/utils/fs";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";

interface SidebarProps {
  workspacePath: string;
  activeTabId: string | null;
  openTabs: string[];
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  closeTab: (tabId: string) => void;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
  onSearchMatchClick: (
    filePath: string,
    line: number,
    column: number,
    matchText?: string,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  searchPanelRef?: Ref<SearchPanelHandle>;
}

export function Sidebar({
  workspacePath,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  mode,
  onModeChange,
  onSearchMatchClick,
  searchPanelRef,
}: SidebarProps) {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);

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

  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const iconSidebarWidth = 48;
      const newWidth = e.clientX - iconSidebarWidth;
      const clampedWidth = Math.max(150, Math.min(400, newWidth));
      setSidebarWidth(clampedWidth);
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

    // When the sidebar mounts (opened), focus the first file item for keyboard nav.
    // Skip this while inline-create/rename modes are active to avoid stealing focus.
    const raf = requestAnimationFrame(() => {
      const hasInlineInput = containerRef.current?.querySelector(
        "input[data-focus-key]",
      );
      if (hasInlineInput) return;

      const firstButton =
        containerRef.current?.querySelector<HTMLButtonElement>("button");
      firstButton?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [mode.type]);

  const handleNewFile = useCallback(() => {
    onModeChange({
      type: "creating",
      parentPath: workspacePath,
      itemType: "file",
    });
  }, [workspacePath, onModeChange]);

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
          closeTab(tabId);
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
      const newPath = getDirectoryPath(oldPath) + "/" + newName;
      if (oldPath === newPath) return;

      const existing = metadata.get(newPath);
      if (existing) {
        console.error(`Cannot rename: "${newPath}" already exists`);
        return;
      }

      renameFileOrDirectory(workspacePath, oldPath, newPath).catch(
        (error: unknown) => {
          console.error(`Failed to rename ${oldPath} to ${newPath}:`, error);
        },
      );
    },
    [workspacePath, metadata],
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
          <SearchPanel
            ref={searchPanelRef}
            workspacePath={workspacePath}
            onMatchClick={onSearchMatchClick}
          />
        ) : sidebarView === "git" ? (
          <CheckpointPanel workspacePath={workspacePath} />
        ) : (
          <>
            <FileTree
              selectedFilePath={activeTabId}
              onFileSelect={onFileSelect}
              onDelete={handleDeleteFile}
              onRename={handleRenameFile}
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
