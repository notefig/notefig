import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useIsFetching } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
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
import { useConfig } from "@/utils/project-config-store";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import type { FileEntry } from "@/utils/fs";
import { getFileName } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { platformAdapter } from "@/adapters";
import { retryOnAnimationFrame } from "@/utils/retry-on-animation-frame";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import {
  disposeAllEditors,
  getEditor,
  navigateToLocation,
} from "@/components/editor/editor-store";
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
  const projectDirection = useConfig((config) => config.editing.textDirection);
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
    getSelectedText,
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
              isContentLoaded: content !== undefined,
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
            isContentLoaded={fileEntry.isContentLoaded}
          />
        </Dockable.Tab>
      )),
    [fileDataWithContent, workspacePath, layout, handleLayoutChange],
  );

  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  const existingOpenTabIds = useMemo(
    () => new Set(fileDataWithContent.map((file) => file.path)),
    [fileDataWithContent],
  );

  const missingOpenTabIds = useMemo(
    () => openTabs.filter((tabId) => !existingOpenTabIds.has(tabId)),
    [openTabs, existingOpenTabIds],
  );

  const [searchParams, setUrlSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";
  const toggleSidebarCollapsed = useCallback(() => {
    const isClosing = !isSidebarCollapsed;

    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("sidebar") === "collapsed") {
          next.delete("sidebar");
        } else {
          next.set("sidebar", "collapsed");
          next.delete("sidebarView");
        }
        return next;
      },
      { replace: true },
    );

    if (isClosing) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-sidebar]")) {
        active.blur();
      }

      retryOnAnimationFrame(() => {
        return focusActiveEditor();
      });
    }
  }, [isSidebarCollapsed, setUrlSearchParams, focusActiveEditor]);

  const handleSearchMatchClick = useCallback(
    (
      filePath: string,
      line: number,
      column: number,
      matchText?: string,
      options?: Omit<OpenFileInLayoutOptions, "tabId">,
    ) => {
      // Open the file tab
      handleFileSelect(
        {
          path: filePath,
          type: "file",
          contentHash: "",
          content: "",
        },
        options,
      );
      // Retry navigation until editor is mounted and ready (up to ~2s)
      let attempt = 0;
      const maxAttempts = 20;
      const tryNavigate = () => {
        attempt++;
        if (
          navigateToLocation(filePath, {
            line,
            column,
            expectedText: matchText,
          })
        )
          return;
        if (attempt < maxAttempts) {
          requestAnimationFrame(tryNavigate);
        }
      };
      requestAnimationFrame(tryNavigate);
    },
    [handleFileSelect],
  );

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  const isFetchingContent = useIsFetching(
    { queryKey: ["file-content", workspacePath] },
    queryClient,
  );
  const isFetchingMetadata = useIsFetching(
    { queryKey: ["file-metadata", workspacePath] },
    queryClient,
  );

  useEffect(() => {
    if (isFetchingMetadata > 0) return;
    if (missingOpenTabIds.length === 0) return;

    const sanitizedLayout = missingOpenTabIds.reduce(
      (nextLayout, tabId) => removeTabFromLayout(nextLayout, tabId),
      layout,
    );

    handleLayoutChange(sanitizedLayout);
  }, [missingOpenTabIds, layout, handleLayoutChange, isFetchingMetadata]);

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

  const openSidebarIfCollapsed = useCallback(() => {
    if (!isSidebarCollapsed) return;

    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("sidebar");
        return next;
      },
      { replace: true },
    );
  }, [isSidebarCollapsed, setUrlSearchParams]);

  const handleNewFile = useCallback(() => {
    openSidebarIfCollapsed();
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "file",
    });
  }, [workspacePath, openSidebarIfCollapsed]);

  const handleNewDirectory = useCallback(() => {
    openSidebarIfCollapsed();
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "directory",
    });
  }, [workspacePath, openSidebarIfCollapsed]);

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
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("settings", "true");
        return next;
      },
      { replace: true },
    );
  }, [setUrlSearchParams]);

  const openSearchPanel = useCallback(
    (options?: { filePattern?: string; initialQuery?: string }) => {
      const filePattern = options?.filePattern;
      const initialQuery = options?.initialQuery;

      // Switch sidebar to search view and expand it
      setUrlSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sidebarView", "search");
          next.delete("sidebar"); // ensure expanded
          return next;
        },
        { replace: true },
      );

      retryOnAnimationFrame(() => {
        if (!searchPanelRef.current) return false;
        searchPanelRef.current.focusInput({ filePattern, initialQuery });
        return true;
      });
    },
    [setUrlSearchParams],
  );

  /** Mod+F — search within the active file */
  const handleSearchInFile = useCallback(() => {
    const selectedText = getSelectedText();

    if (activeTabId) {
      openSearchPanel({
        filePattern: getFileName(activeTabId),
        initialQuery: selectedText,
      });
    } else {
      openSearchPanel({ initialQuery: selectedText });
    }
  }, [activeTabId, getSelectedText, openSearchPanel]);

  /** Mod+Shift+F — global search across all files */
  const handleSearchInFiles = useCallback(() => {
    const selectedText = getSelectedText();

    openSearchPanel({ initialQuery: selectedText });
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
      dir={projectDirection}
      className="flex h-full w-full overflow-hidden p-2"
    >
      <div className="flex h-full shrink-0 overflow-hidden rounded-xl border border-border">
        <IconSidebar
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
        />

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
      </div>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <DebugPanel />

        <div className="flex-1 flex min-h-0 overflow-hidden">
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
        isSynced={isSynced}
        workspacePath={workspacePath}
      />

      <SettingsModal onFocusEditor={focusActiveEditor} />

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
        direction={projectDirection}
      />
    </div>
  );
};
