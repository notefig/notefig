import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useIsFetching } from "@tanstack/react-query";
import { Dockable } from "@/components/dockable";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { Sidebar } from "@/components/editor/sidebar";
import type { SearchPanelHandle } from "@/components/editor/search-panel";
import {
  PolymorphicEditor,
  canOpenFile as canOpenInEditor,
} from "@/components/editor/polymorphic-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import {
  getOrCreateWorkspaceCollections,
  queryClient,
} from "@/utils/collections";
import { useLiveQuery, eq, inArray } from "@tanstack/react-db";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import type { FileEntry } from "@/utils/fs";
import { getFileName } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import { platformAdapter } from "@/adapters";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import {
  disposeAllEditors,
  getEditor,
  navigateToLocation,
} from "@/components/editor/editor-store";
import { useSearchParams } from "react-router";
import {
  type FileTreeMode,
  FILE_TREE_IDLE,
} from "@/components/editor/file-tree";

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  if (!workspacePath) {
    return null;
  }

  const { metadata, content } = getOrCreateWorkspaceCollections(workspacePath);
  const { t } = useTranslation();
  const dockableRef = useRef<HTMLDivElement>(null);
  const searchPanelRef = useRef<SearchPanelHandle>(null);

  const {
    layout,
    openTabs,
    activeTabId,
    handleFileSelect,
    handleLayoutChange,
    closeTab,
    closeActiveTab,
    getFocusedTabId,
    focusActiveEditor,
  } = useDockableTabs({
    renderTabs: () => [],
    canOpenFile: (file) => file.type === "file" && canOpenInEditor(file.path),
    dockableRef,
  });

  useEffect(() => {
    return () => {
      disposeAllEditors();
    };
  }, []);

  // Query metadata and content for all open tabs
  // Uses left join so files appear immediately (metadata loads eagerly)
  // Content loads on-demand; Suspense in PolymorphicEditor handles loading state
  const { data: fileDataWithContent = [] } = useLiveQuery(
    (q) =>
      openTabs.length === 0
        ? undefined
        : q
            .from({ file: metadata })
            .where(({ file }) => inArray(file.path, openTabs))
            .leftJoin({ content }, ({ file, content }) =>
              eq(file.path, content.path),
            )
            .select(({ file, content }) => ({
              ...file,
              content: content?.content ?? "",
              contentHash: content?.contentHash ?? "",
            })),
    [workspacePath, ...openTabs],
  );

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
          <PolymorphicEditor
            file={fileEntry as FileEntry}
            basePath={workspacePath}
          />
        </Dockable.Tab>
      )),
    [fileDataWithContent, workspacePath, layout, handleLayoutChange],
  );

  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  const [searchParams, setSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";
  const toggleSidebarCollapsed = useCallback(() => {
    const isClosing = searchParams.get("sidebar") !== "collapsed";

    setSearchParams((prev) => {
      if (prev.get("sidebar") === "collapsed") {
        prev.delete("sidebar");
      } else {
        prev.set("sidebar", "collapsed");
      }
      return prev;
    });

    if (isClosing) {
      requestAnimationFrame(() => {
        focusActiveEditor();
      });
    }
  }, [searchParams, setSearchParams, focusActiveEditor]);

  const handleSearchMatchClick = useCallback(
    (filePath: string, line: number, column: number) => {
      // Open the file tab
      handleFileSelect({
        path: filePath,
        type: "file",
        contentHash: "",
        content: "",
      });
      // Retry navigation until editor is mounted and ready (up to ~2s)
      let attempt = 0;
      const maxAttempts = 20;
      const tryNavigate = () => {
        attempt++;
        if (navigateToLocation(filePath, { line, column })) return;
        if (attempt < maxAttempts) {
          requestAnimationFrame(tryNavigate);
        }
      };
      requestAnimationFrame(tryNavigate);
    },
    [handleFileSelect],
  );

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");

  const isFetchingContent = useIsFetching(
    { queryKey: ["file-content", workspacePath] },
    queryClient,
  );
  const isSynced = isFetchingContent === 0;
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

  const [fileTreeMode, setFileTreeMode] =
    useState<FileTreeMode>(FILE_TREE_IDLE);

  const handleNewFile = useCallback(() => {
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "file",
    });
  }, [workspacePath]);

  const handleNewDirectory = useCallback(() => {
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "directory",
    });
  }, [workspacePath]);

  const runEditorHistoryAction = useCallback(
    (action: "undo" | "redo") => {
      const focusedTabId = getFocusedTabId();
      if (!focusedTabId) return;

      const editor = getEditor(focusedTabId) as
        | { undo?: () => void; redo?: () => void }
        | undefined;

      if (action === "undo") {
        editor?.undo?.();
      } else {
        editor?.redo?.();
      }
    },
    [getFocusedTabId],
  );

  const handleToggleFullscreen = useCallback(() => {
    platformAdapter.toggleFullscreen().catch((error: unknown) => {
      console.error("Failed to toggle fullscreen:", error);
    });
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSearchParams((prev) => {
      prev.set("settings", "true");
      return prev;
    });
  }, [setSearchParams]);

  const openSearchPanel = useCallback(
    (filePattern?: string) => {
      // Switch sidebar to search view and expand it
      setSearchParams((prev) => {
        prev.set("sidebarView", "search");
        prev.delete("sidebar"); // ensure expanded
        return prev;
      });

      // Focus input after sidebar view switch renders
      requestAnimationFrame(() => {
        searchPanelRef.current?.focusInput(filePattern);
      });
    },
    [setSearchParams],
  );

  /** Mod+F — search within the active file */
  const handleSearchInFile = useCallback(() => {
    if (activeTabId) {
      openSearchPanel(getFileName(activeTabId));
    } else {
      openSearchPanel();
    }
  }, [activeTabId, openSearchPanel]);

  /** Mod+Shift+F — global search across all files */
  const handleSearchInFiles = useCallback(() => {
    openSearchPanel();
  }, [openSearchPanel]);

  useHotkey("Mod+N", () => {
    handleNewFile();
  });

  useHotkey("Mod+F", () => {
    handleSearchInFile();
  });

  useHotkey("Mod+Shift+F", () => {
    handleSearchInFiles();
  });

  useEffect(() => {
    const metadataWatchId = `metadata-${workspacePath}`;
    const contentWatchId = `content-${workspacePath}`;
    let eventCleanup: (() => void) | undefined;
    let isActive = true;

    const setupWatchers = async () => {
      try {
        eventCleanup = platformAdapter.addEventListener((event) => {
          if (!isActive) return;
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
      } catch (error) {
        console.error("Failed to setup watchers:", error);
      }
    };

    setupWatchers();

    return () => {
      isActive = false;
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
        <DebugPanel />

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {!isSidebarCollapsed && (
            <Sidebar
              workspacePath={workspacePath}
              activeTabId={activeTabId}
              openTabs={openTabs}
              onFileSelect={handleFileSelect}
              closeTab={closeTab}
              mode={fileTreeMode}
              onModeChange={setFileTreeMode}
              onSearchMatchClick={handleSearchMatchClick}
              searchPanelRef={searchPanelRef}
            />
          )}

          <div
            ref={dockableRef}
            className="flex-1 min-w-0 h-full overflow-hidden"
            tabIndex={-1}
          >
            {openTabs.length === 0 ? (
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

      <SettingsModal
        direction={direction}
        onDirectionChange={setDirection}
        onFocusEditor={focusActiveEditor}
      />

      <CommandPalette
        open={isCommandPaletteOpen}
        sidebarOpen={isSidebarCollapsed}
        onOpenChange={setIsCommandPaletteOpen}
        onNewFile={handleNewFile}
        onNewDirectory={handleNewDirectory}
        onCloseFile={closeActiveTab}
        onUndo={() => runEditorHistoryAction("undo")}
        onRedo={() => runEditorHistoryAction("redo")}
        onOpenSettings={handleOpenSettings}
        onToggleSidebar={toggleSidebarCollapsed}
        onToggleFullscreen={handleToggleFullscreen}
        onSearchInFile={handleSearchInFile}
        onSearchInFiles={handleSearchInFiles}
        onFocusEditor={focusActiveEditor}
        direction={direction}
      />
    </div>
  );
};
