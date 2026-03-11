import { useState, useEffect, useRef, useCallback } from "react";
import { FileTree, type FileTreeMode } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import {
  getOrCreateWorkspaceCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  createFile,
  createDirectory,
} from "@/utils/collections";
import { getDirectoryPath, isTextFile } from "@/utils/fs";
import type { FileTreeNode, SortOrder } from "@/utils/fs";
import { useSearchParams } from "react-router";

interface SidebarProps {
  workspacePath: string;
  activeTabId: string | null;
  openTabs: string[];
  onFileSelect: (file: FileTreeNode) => void;
  closeTab: (tabId: string) => void;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
}

export function Sidebar({
  workspacePath,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  mode,
  onModeChange,
}: SidebarProps) {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);

  const [searchParams, setSearchParams] = useSearchParams();
  const sortOrder = (searchParams.get("sort") as SortOrder) || "name-asc";
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setSearchParams((prev) => {
        if (order === "name-asc") {
          prev.delete("sort");
        } else {
          prev.set("sort", order);
        }
        return prev;
      });
    },
    [setSearchParams],
  );

  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

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
      const fullPath = parentPath + "/" + name;

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

  return (
    <>
      <div
        className="shrink-0 bg-sidebar flex flex-col border-border"
        style={{ width: sidebarWidth }}
      >
        <FileControls
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          sortOrder={sortOrder}
          onSortChange={setSortOrder}
        />
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
      </div>
      <div
        ref={resizeRef}
        onMouseDown={handleResizeStart}
        className="w-0.5 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
      />
    </>
  );
}
