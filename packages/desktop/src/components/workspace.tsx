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
import { useProjectSettings } from "@/utils/project-settings";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import type { FileEntry } from "@/utils/fs";
import { getFileName } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { WorkspaceTabsProvider } from "@/components/workspace-tabs-provider";
import { useThrowWorkspaceAccessError } from "@/components/workspace-error-boundary";
import { platformAdapter } from "@/adapters";
import { retryOnAnimationFrame } from "@/utils/retry-on-animation-frame";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import { disposeAllEditors, getEditor } from "@/components/editor/editor-store";
import { AgentPanel } from "@/components/agent/agent-panel";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
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
  useThrowWorkspaceAccessError(workspacePath);
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
    openFile,
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

  // Tear down agent tasks (kills adapter processes) and clear their rows when
  // leaving the workspace — alongside editor disposal.
  useEffect(() => {
    return () => {
      void disposeWorkspaceTaskManager(workspacePath);
    };
  }, [workspacePath]);

  // Query metadata and content for all open tabs
  // Uses left join so files appear immediately (metadata loads eagerly)
  // Content loads on-demand; PolymorphicEditor shows a placeholder until it arrives
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
              contentError: content?.error,
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
            contentError={fileEntry.contentError}
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

  const isAgentOpen = searchParams.get("agent") === "open";
  const toggleAgentPanel = useCallback(() => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("agent") === "open") next.delete("agent");
        else next.set("agent", "open");
        return next;
      },
      { replace: true },
    );
  }, [setUrlSearchParams]);

  // Exposed via WorkspaceTabsContext so components nested in the layout
  // (link menu, search panel) can open files as tabs.
  const openFileInTabs = useCallback(
    (options: OpenFileInLayoutOptions) => {
      if (!canOpenInEditor(options.tabId)) return false;
      openFile(options);
      return true;
    },
    [openFile],
  );

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const { settings: projectSettings, update: updateProjectSettings } =
    useProjectSettings(workspacePath);
  const direction = projectSettings.direction;
  const setDirection = useCallback(
    (next: "ltr" | "rtl") => {
      updateProjectSettings({ settings: { direction: next } }).catch(
        (error) => {
          console.error("Failed to persist direction setting:", error);
        },
      );
    },
    [updateProjectSettings],
  );

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

  useHotkey("Mod+Shift+A", () => {
    toggleAgentPanel();
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
    <WorkspaceTabsProvider openFile={openFileInTabs}>
      <div
        dir={direction}
        className="relative flex h-full w-full overflow-hidden p-2"
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

            {isAgentOpen && (
              <div className="w-96 shrink-0 h-full">
                <AgentPanel workspacePath={workspacePath} />
              </div>
            )}
          </div>
        </div>

        <button
          onClick={toggleAgentPanel}
          className={`absolute end-4 top-3 z-10 rounded-md px-2 py-1 text-xs shadow-sm ${
            isAgentOpen
              ? "bg-accent text-accent-foreground"
              : "bg-background/80 text-muted-foreground hover:bg-muted"
          }`}
          title="Toggle agent panel (⌘⇧A)"
        >
          Agent
        </button>

        <StatusBar
          wordCount={wordCount}
          isSynced={isSynced}
          workspacePath={workspacePath}
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
    </WorkspaceTabsProvider>
  );
};
