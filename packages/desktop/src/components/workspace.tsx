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
import { AgentChatTab } from "@/components/agent/agent-chat-tab";
import { FloatingPrompt } from "@/components/agent/floating-prompt";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
import { agentTasksCollection } from "@/agent/agent-collections";
import {
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
} from "@/utils/agent-tab-id";
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

  // Agent chat tabs share the layout with file tabs but are keyed
  // `agent:<taskId>` — split them out so every file-path code path
  // (metadata queries, content watching, missing-file pruning) sees only
  // real paths.
  const fileOpenTabIds = useMemo(
    () => openTabs.filter((tabId) => !isAgentTabId(tabId)),
    [openTabs],
  );
  const agentOpenTaskIds = useMemo(
    () =>
      openTabs
        .map(agentTaskIdFromTabId)
        .filter((taskId): taskId is string => taskId !== null),
    [openTabs],
  );

  // Query metadata and content for all open tabs
  // Uses left join so files appear immediately (metadata loads eagerly)
  // Content loads on-demand; PolymorphicEditor shows a placeholder until it arrives
  const { data: fileDataWithContent = [] } = useLiveQuery(
    (q) =>
      fileOpenTabIds.length === 0
        ? undefined
        : q
            .from({ file: metadata })
            .where(({ file }) => inArray(file.path, fileOpenTabIds))
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
    [workspacePath, ...fileOpenTabIds],
  );

  // Task rows for open agent tabs. Chat tab titles/state track the rows live.
  const { data: openAgentTaskRows = [] } = useLiveQuery(
    (q) =>
      agentOpenTaskIds.length === 0
        ? undefined
        : q
            .from({ task: agentTasksCollection })
            .where(({ task }) => inArray(task.taskId, agentOpenTaskIds)),
    [...agentOpenTaskIds],
  );

  const agentDockableTabs = useMemo(
    () =>
      openAgentTaskRows.map((task) => (
        <Dockable.Tab
          key={agentTabId(task.taskId)}
          id={agentTabId(task.taskId)}
          // Session titles are first-prompt text (up to 60 chars) — far
          // wider than file names, so give tabs a much shorter ellipsis.
          name={
            task.title.length > 24
              ? `${task.title.slice(0, 23).trimEnd()}…`
              : task.title
          }
          // closeTab (functional layout update) rather than a closure over
          // `layout`: keeps this memo stable across tab selects/drags. It
          // never cancels the session — that stays reachable from the
          // sessions sidebar.
          onClose={() => closeTab(agentTabId(task.taskId))}
        >
          <AgentChatTab taskId={task.taskId} />
        </Dockable.Tab>
      )),
    [openAgentTaskRows, closeTab],
  );

  const dockableTabs = useMemo(
    () =>
      fileDataWithContent.map((fileEntry) => (
        <Dockable.Tab
          key={fileEntry.path}
          id={fileEntry.path}
          name={getFileName(fileEntry.path)}
          onClose={() => closeTab(fileEntry.path)}
        >
          <PolymorphicEditor
            file={fileEntry as FileEntry}
            basePath={workspacePath}
            isContentLoaded={fileEntry.isContentLoaded}
            contentError={fileEntry.contentError}
          />
        </Dockable.Tab>
      )),
    [fileDataWithContent, workspacePath, closeTab],
  );

  const allDockableTabs = useMemo(
    () => [...dockableTabs, ...agentDockableTabs],
    [dockableTabs, agentDockableTabs],
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
    () => fileOpenTabIds.filter((tabId) => !existingOpenTabIds.has(tabId)),
    [fileOpenTabIds, existingOpenTabIds],
  );

  // Agent tabs whose task row is gone. Rows live only for the app run, so a
  // restored `?layout` after a restart carries dead agent tabs — prune them
  // like missing files (revisit with MET-54 agent-state persistence). The
  // local-only collection is synchronously readable, so no fetching gate.
  const missingAgentTabIds = useMemo(
    () =>
      agentOpenTaskIds
        .filter((taskId) => !agentTasksCollection.get(taskId))
        .map(agentTabId),
    [agentOpenTaskIds, openAgentTaskRows],
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

  const [floatingPromptOpen, setFloatingPromptOpen] = useState(false);

  // Exposed via WorkspaceTabsContext so components nested in the layout
  // (link menu, search panel) can open files as tabs.
  const openFileInTabs = useCallback(
    (options: OpenFileInLayoutOptions) => {
      if (!isAgentTabId(options.tabId) && !canOpenInEditor(options.tabId)) {
        return false;
      }
      openFile(options);
      return true;
    },
    [openFile],
  );

  // Open (or focus — openFileInLayout dedupes by id) a session's chat tab.
  // `new-tab` intent: a session must never replace the file tab in view.
  const openAgentTab = useCallback(
    (taskId: string) => {
      openFile({ tabId: agentTabId(taskId), intent: "new-tab" });
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
    // File tabs wait out the metadata fetch; agent tabs need no gate (their
    // collection is local-only). One pass so concurrent prunes can't race
    // each other's layout writes.
    const staleTabIds = [
      ...(isFetchingMetadata > 0 ? [] : missingOpenTabIds),
      ...missingAgentTabIds,
    ];
    if (staleTabIds.length === 0) return;

    const sanitizedLayout = staleTabIds.reduce(
      (nextLayout, tabId) => removeTabFromLayout(nextLayout, tabId),
      layout,
    );

    handleLayoutChange(sanitizedLayout);
  }, [
    missingOpenTabIds,
    missingAgentTabIds,
    layout,
    handleLayoutChange,
    isFetchingMetadata,
  ]);

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

  /** Mod+Shift+A — the agent sessions menu in the left sidebar. */
  const openSessionsSidebar = useCallback(() => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("sidebarView", "sessions");
        next.delete("sidebar"); // ensure expanded
        return next;
      },
      { replace: true },
    );
  }, [setUrlSearchParams]);

  useHotkey("Mod+Shift+A", () => {
    openSessionsSidebar();
  });

  useHotkey("Mod+I", () => {
    setFloatingPromptOpen((current) => !current);
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

        if (fileOpenTabIds.length > 0) {
          await platformAdapter.startWatchingContent(
            fileOpenTabIds,
            contentWatchId,
          );
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
      if (fileOpenTabIds.length > 0) {
        platformAdapter.stopWatching(contentWatchId);
      }
    };
  }, [workspacePath, fileOpenTabIds.join(",")]);

  return (
    <WorkspaceTabsProvider openFile={openFileInTabs} openAgentTab={openAgentTab}>
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
                  {allDockableTabs}
                </Dockable.Root>
              )}
            </div>
          </div>
        </div>

        <FloatingPrompt
          workspacePath={workspacePath}
          open={floatingPromptOpen}
          onOpenChange={setFloatingPromptOpen}
        />

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
