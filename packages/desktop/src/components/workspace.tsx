import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Dockable } from "@/components/dockable";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { Sidebar } from "@/components/editor/sidebar";
import type { SearchPanelHandle } from "@/components/editor/search-panel";
import { canOpenFile as canOpenInEditor } from "@/components/editor/polymorphic-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import { useContentFetching } from "@/entities/files";
import { useFileWatchers } from "@/utils/file-sync";
import { useWorkspaceTabs, renameOpenFileTab } from "@/entities/tabs";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useNavigationPersistence } from "@/hooks/use-recent-projects";
import { useProjectSettings } from "@/utils/project-settings";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import { useWorkspaceCommands } from "@/hooks/use-workspace-commands";
import { useWorkspacePanels } from "@/hooks/use-workspace-panels";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { WorkspaceTabsProvider } from "@/components/workspace-tabs-provider";
import { PromptWidgetBoundary } from "@/components/agent/prompt-widget-boundary";
import { useThrowWorkspaceAccessError } from "@/components/workspace-error-boundary";
import { disposeAllEditors } from "@/components/editor/editor-store";
import { disposeWorkspaceTaskManager } from "@/agent/agent-service";
import { agentTabId, tabKind } from "@/entities/tabs";
import { useTabElements } from "@/tabs/tab-types";
import { useReleaseNotesOnUpdate } from "@/hooks/use-release-notes-on-update";
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
  useNavigationPersistence();
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
    renameTab,
    closeActiveTab,
    getFocusedTabId,
    focusActiveTab,
    getSelectedText,
    openFile,
  } = useDockableTabs({
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
    staleTabIds,
  } = useWorkspaceTabs(workspacePath, openTabs);

  useReleaseNotesOnUpdate(openFile);

  // One element per open tab, built from the tab-type registry (title +
  // content per kind) and memoised per tab id.
  const allDockableTabs = useTabElements(openTabs, {
    workspacePath,
    fileRows: fileDataWithContent,
    agentTaskRows: openAgentTaskRows,
    closeTab,
  });

  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  const {
    isSidebarCollapsed,
    toggleSidebarCollapsed,
    openSidebarIfCollapsed,
    openSettings,
    openSearchPanel,
    openSessionsSidebar,
  } = useWorkspacePanels({ searchPanelRef, focusActiveTab });

  // Exposed via WorkspaceTabsContext so components nested in the layout
  // (link menu, search panel) can open files as tabs.
  const openFileInTabs = useCallback(
    (options: OpenFileInLayoutOptions) => {
      // Only file tabs are gated on the editor's format support; the other
      // tab kinds carry their own content.
      if (
        tabKind(options.tabId) === "file" &&
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
  const wordCount = useMemo(() => {
    if (!currentContent) return null;
    const words = currentContent
      .trim()
      .split(/\s+/)
      .filter((word: string) => word.length > 0);
    return words.length;
  }, [currentContent]);

  const [fileTreeMode, setFileTreeMode] =
    useState<FileTreeMode>(FILE_TREE_IDLE);

  const {
    handleNewScratchpad,
    handleNewFile,
    handleNewDirectory,
    runHistoryAction,
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
    openFile: openFileInTabs,
    openSearchPanel,
    openSessionsSidebar,
  });

  // Rename/move a file while its tab is open — the close-and-reopen
  // primitive keeps the tab in its window slot.
  const handleRenameOpenFile = useCallback(
    (oldPath: string, newPath: string) =>
      renameOpenFileTab({
        workspacePath,
        oldPath,
        newPath,
        applyLayoutRename: renameTab,
      }),
    [workspacePath, renameTab],
  );

  useFileWatchers(workspacePath, fileOpenTabIds);

  return (
    <WorkspaceTabsProvider
      openFile={openFileInTabs}
      openAgentTab={openAgentTab}
    >
      <PromptWidgetBoundary>
        <div
          dir={direction}
          className="relative flex h-full w-full overflow-clip p-2"
        >
          <div className="flex h-full shrink-0 overflow-clip rounded-xl border border-border">
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
                onRenameOpenFile={handleRenameOpenFile}
                mode={fileTreeMode}
                onModeChange={setFileTreeMode}
                searchPanelRef={searchPanelRef}
              />
            )}
          </div>

          <div className="flex-1 flex flex-col min-w-0 overflow-clip">
            <DebugPanel />

            <div className="flex-1 flex min-h-0 overflow-clip">
              <div
                ref={dockableRef}
                className="flex-1 min-w-0 h-full overflow-clip"
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
            onFocusTab={focusActiveTab}
          />

          <CommandPalette
            open={isCommandPaletteOpen}
            sidebarOpen={isSidebarCollapsed}
            workspacePath={workspacePath}
            onOpenChange={setIsCommandPaletteOpen}
            onNewScratchpad={handleNewScratchpad}
            onNewFile={handleNewFile}
            onNewDirectory={handleNewDirectory}
            onCloseFile={closeActiveTab}
            onUndo={() => runHistoryAction("undo")}
            onRedo={() => runHistoryAction("redo")}
            onOpenSettings={openSettings}
            onToggleSidebar={toggleSidebarCollapsed}
            onToggleFullscreen={handleToggleFullscreen}
            onSearchInFile={handleSearchInFile}
            onSearchInFiles={handleSearchInFiles}
            onFocusTab={focusActiveTab}
            direction={direction}
          />
        </div>
      </PromptWidgetBoundary>
    </WorkspaceTabsProvider>
  );
};
