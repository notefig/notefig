import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Dockable } from "@/components/dockable";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { FileTree } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import {
  getOrCreateWorkspaceCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
} from "@/utils/collections";
import { useLiveQuery, eq, inArray } from "@tanstack/react-db";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import type { FileEntry, SortOrder } from "@/utils/fs";
import { getFileName, getDirectoryPath, isTextFile } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import { platformAdapter } from "@/adapters";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import { disposeAllEditors } from "@/components/editor/editor-store";
import { useSearchParams } from "react-router";

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  if (!workspacePath) {
    return null;
  }

  const { metadata, content } = getOrCreateWorkspaceCollections(workspacePath);
  const { t } = useTranslation();

  const {
    layout,
    openTabs,
    activeTabId,
    handleFileSelect,
    handleLayoutChange,
    closeTab,
  } = useDockableTabs({
    renderTabs: () => [],
    canOpenFile: (file) => file.type === "file" && isTextFile(file.path),
  });

  useEffect(() => {
    return () => {
      disposeAllEditors();
    };
  }, []);

  const { data: fileDataWithContent = [] } = useLiveQuery(
    (q) =>
      openTabs.length === 0
        ? undefined
        : q
            .from({ file: metadata })
            .where(({ file }) => inArray(file.path, openTabs))
            .join({ content }, ({ file, content }) =>
              eq(file.path, content.path),
            )
            .where(({ content }) => inArray(content?.path, openTabs))
            .select(({ file, content }) => ({
              ...file,
              content: content?.content,
              contentHash: content?.contentHash,
            })),
    [workspacePath, ...openTabs],
  );

  // Build Dockable tabs
  const dockableTabs = useMemo(
    () =>
      fileDataWithContent.map((fileEntry) => (
        <Dockable.Tab
          key={fileEntry.path}
          id={fileEntry.path}
          name={getFileName(fileEntry.path)}
          onClose={() => {
            const nextLayout = removeTabFromLayout(layout, fileEntry.path);
            handleLayoutChange(nextLayout);
          }}
        >
          <TextEditor file={fileEntry as FileEntry} basePath={workspacePath} />
        </Dockable.Tab>
      )),
    [fileDataWithContent, workspacePath, layout, handleLayoutChange],
  );

  // Get current content for status bar from active tab
  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  // ── UI state ──
  const [searchParams, setSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";
  const toggleSidebarCollapsed = useCallback(() => {
    setSearchParams((prev) => {
      if (prev.get("sidebar") === "collapsed") {
        prev.delete("sidebar");
      } else {
        prev.set("sidebar", "collapsed");
      }
      return prev;
    });
  }, [setSearchParams]);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isSynced] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");
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
  const resizeRef = useRef<HTMLDivElement>(null);

  const { wordCount, characterCount } = useMemo(() => {
    const words = currentContent
      .trim()
      .split(/\s+/)
      .filter((word: string) => word.length > 0);
    return {
      wordCount: words.length,
      characterCount: currentContent.length,
    };
  }, [currentContent]);

  // ── Sidebar resize ──
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
    //TODO: handle new tab + new file creation
  }, []);

  const handleDeleteFile = useCallback(
    (path: string) => {
      // Close any open tabs for the deleted file (or children if directory)
      const pathPrefix = path.endsWith("/") ? path : path + "/";
      for (const tabId of openTabs) {
        if (tabId === path || tabId.startsWith(pathPrefix)) {
          closeTab(tabId);
        }
      }

      // Delete from collections (triggers FS delete via mutation handler)
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

      // Duplicate check
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

  // ── File watchers ──
  useEffect(() => {
    const metadataWatchId = `metadata-${workspacePath}`;
    const contentWatchId = `content-${workspacePath}`;
    let eventCleanup: (() => void) | undefined;

    const setupWatchers = async () => {
      eventCleanup = platformAdapter.addEventListener((event) => {
        if (event.type === "fs-metadata-changed") {
          handleMetadataFileSystemChange(event.payload, workspacePath);
        } else if (event.type === "fs-content-changed") {
          handleContentFileSystemChange(event.payload, workspacePath);
        }
      });

      await platformAdapter.startWatchingMetadata(
        [workspacePath],
        metadataWatchId,
      );

      if (openTabs.length > 0) {
        await platformAdapter.startWatchingContent(openTabs, contentWatchId);
      }
    };

    setupWatchers();

    return () => {
      eventCleanup?.();
      platformAdapter.stopWatching(metadataWatchId);
      if (openTabs.length > 0) {
        platformAdapter.stopWatching(contentWatchId);
      }
    };
  }, [workspacePath, openTabs.join(",")]);

  return (
    <div
      dir={direction}
      className="flex h-full w-full bg-background overflow-hidden"
    >
      <IconSidebar
        onCommandPaletteClick={() => setIsCommandPaletteOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <DebugPanel
          isEditRoute={true}
          openTabs={openTabs}
          activeTabId={activeTabId}
          dockableLayout={layout}
        />

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* ── File tree sidebar ── */}
          {!isSidebarCollapsed && (
            <>
              <div
                className="shrink-0 bg-sidebar flex flex-col border-border"
                style={{ width: sidebarWidth }}
              >
                <FileControls
                  onNewFile={handleNewFile}
                  onNewFolder={() => {}}
                  sortOrder={sortOrder}
                  onSortChange={setSortOrder}
                />
                <FileTree
                  selectedFilePath={activeTabId}
                  onFileSelect={handleFileSelect}
                  onDelete={handleDeleteFile}
                  onRename={handleRenameFile}
                  openTabs={openTabs}
                  basePath={workspacePath!}
                  sortOrder={sortOrder}
                />
              </div>
              <div
                ref={resizeRef}
                onMouseDown={handleResizeStart}
                className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
              />
            </>
          )}

          {/* ── Editor area (Dockable) ── */}
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            {openTabs.length === 0 || dockableTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground p-4 ps-0">
                <p className="text-center">{t("noFileSelected")}</p>
              </div>
            ) : (
              <Dockable.Root
                orientation="row"
                layout={layout}
                onChange={handleLayoutChange}
              >
                {dockableTabs}
              </Dockable.Root>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        wordCount={wordCount}
        characterCount={characterCount}
        isSynced={isSynced}
      />

      <SettingsModal direction={direction} onDirectionChange={setDirection} />

      <CommandPalette
        open={isCommandPaletteOpen}
        onOpenChange={setIsCommandPaletteOpen}
        onNewFile={handleNewFile}
        onOpenSettings={() => {
          setIsCommandPaletteOpen(false);
        }}
        onToggleSidebar={toggleSidebarCollapsed}
        direction={direction}
      />
    </div>
  );
};
