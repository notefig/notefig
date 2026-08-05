import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import { useContentFetching } from "@/entities/files";
import { useFileWatchers } from "@/utils/file-sync";
import { useWorkspaceTabs } from "@/entities/tabs";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useProjectSettings } from "@/utils/project-settings";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import { useWorkspaceCommands } from "@/hooks/use-workspace-commands";
import type { FileEntry } from "@/utils/fs";
import { getFileName } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { WorkspaceTabsProvider } from "@/components/workspace-tabs-provider";
import { useThrowWorkspaceAccessError } from "@/components/workspace-error-boundary";
import { retryOnAnimationFrame } from "@/utils/retry-on-animation-frame";
import { disposeAllEditors } from "@/components/editor/editor-store";
import { AgentChatTab } from "@/components/agent/agent-chat-tab";
import { ReleaseNotesTab } from "@/components/release-notes-tab";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
import {
  agentTabId,
  isAgentTabId,
  isReleaseNotesTabId,
  RELEASE_NOTES_TAB_ID,
} from "@/entities/tabs";
import { useReleaseNotesOnUpdate } from "@/hooks/use-release-notes-on-update";
import { latestReleaseTitle } from "@/utils/release-notes";
import {
  type FileTreeMode,
  FILE_TREE_IDLE,
} from "@/components/editor/file-tree";

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  if (!workspacePath) {
    return null;
  }

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

  // Tear down agent runtimes when leaving the workspace (their rows persist
  // and demote to "restored" — the tasks collection is storage-backed,
  // MET-54). On mount, kick the collection's boot load so restored sessions
  // are in place before tab pruning runs.
  useEffect(() => {
    return () => {
      void disposeWorkspaceTaskManager(workspacePath);
    };
  }, [workspacePath]);

  // The open-tabs cross-entity join (agent/file split, metadata ⋈ content
  // rows, agent task rows, stale-tab detection) lives on the tabs entity.
  const {
    fileTabIds: fileOpenTabIds,
    fileRows: fileDataWithContent,
    agentTaskRows: openAgentTaskRows,
    isReleaseNotesTabOpen,
    staleTabIds,
  } = useWorkspaceTabs(workspacePath, openTabs);

  useReleaseNotesOnUpdate(openFile);

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

  const releaseNotesDockableTabs = useMemo(
    () =>
      isReleaseNotesTabOpen
        ? [
            <Dockable.Tab
              key={RELEASE_NOTES_TAB_ID}
              id={RELEASE_NOTES_TAB_ID}
              name={latestReleaseTitle ?? t("whatsNew")}
              onClose={() => closeTab(RELEASE_NOTES_TAB_ID)}
            >
              <ReleaseNotesTab />
            </Dockable.Tab>,
          ]
        : [],
    [isReleaseNotesTabOpen, closeTab, t],
  );

  const allDockableTabs = useMemo(
    () => [...dockableTabs, ...agentDockableTabs, ...releaseNotesDockableTabs],
    [dockableTabs, agentDockableTabs, releaseNotesDockableTabs],
  );

  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

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

  // Exposed via WorkspaceTabsContext so components nested in the layout
  // (link menu, search panel) can open files as tabs.
  const openFileInTabs = useCallback(
    (options: OpenFileInLayoutOptions) => {
      if (
        !isAgentTabId(options.tabId) &&
        !isReleaseNotesTabId(options.tabId) &&
        !canOpenInEditor(options.tabId)
      ) {
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

  const isFetchingContent = useContentFetching(workspacePath);

  useEffect(() => {
    // One pass so concurrent prunes can't race each other's layout writes;
    // the fetch/boot-load gating already happened inside useWorkspaceTabs.
    if (staleTabIds.length === 0) return;

    const sanitizedLayout = staleTabIds.reduce(
      (nextLayout, tabId) => removeTabFromLayout(nextLayout, tabId),
      layout,
    );

    handleLayoutChange(sanitizedLayout);
  }, [staleTabIds, layout, handleLayoutChange]);

  const isSynced = !isFetchingContent;
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

  const {
    handleNewFile,
    handleNewDirectory,
    runEditorHistoryAction,
    handleToggleFullscreen,
    handleSearchInFile,
    handleSearchInFiles,
  } = useWorkspaceCommands({
    workspacePath,
    activeTabId,
    getFocusedTabId,
    getSelectedText,
    openSidebarIfCollapsed,
    setFileTreeMode,
    openSearchPanel,
    openSessionsSidebar,
  });

  useFileWatchers(workspacePath, fileOpenTabIds);

  return (
    <WorkspaceTabsProvider
      openFile={openFileInTabs}
      openAgentTab={openAgentTab}
    >
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
