import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type React from "react";
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

  useWorkspaceLifecycle(workspacePath);
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
    canOpenFile: canOpenFileInTab,
    dockableRef,
  });

  const { allDockableTabs, wordCount, isSynced } = useWorkspaceDocuments({
    workspacePath,
    openTabs,
    activeTabId,
    layout,
    handleLayoutChange,
    closeTab,
    openFile,
  });

  const {
    isSidebarCollapsed,
    toggleSidebarCollapsed,
    openSidebarIfCollapsed,
    openSettings,
    openSearchPanel,
    openSessionsSidebar,
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    direction,
    setDirection,
  } = useWorkspaceChrome(workspacePath, searchPanelRef, focusActiveTab);

  const {
    openFileInTabs,
    openAgentTab,
    handleRenameOpenFile,
    fileTreeMode,
    setFileTreeMode,
    handleNewScratchpad,
    handleNewFile,
    handleNewDirectory,
    runHistoryAction,
    handleToggleFullscreen,
    handleSearchInFile,
    handleSearchInFiles,
  } = useWorkspaceActions({
    workspacePath,
    activeTabId,
    getFocusedTabId,
    getSelectedText,
    openSidebarIfCollapsed,
    openSearchPanel,
    openSessionsSidebar,
    openFile,
    renameTab,
  });

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
                <DockArea
                  hasTabs={openTabs.length > 0}
                  layout={layout}
                  onLayoutChange={handleLayoutChange}
                >
                  {allDockableTabs}
                </DockArea>
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

/** Open-as-tab entry points, exposed via WorkspaceTabsContext so components
 *  nested in the layout (link menu, search panel) can open files as tabs. */
function useWorkspaceFileOpeners(
  openFile: (options: OpenFileInLayoutOptions) => void,
) {
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

  return { openFileInTabs, openAgentTab };
}

/** The workspace's text direction, persisted in project settings. */
function useDirectionSetting(workspacePath: string) {
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
  return { direction, setDirection };
}

/** Drop tabs whose backing rows are gone. One pass so concurrent prunes
 *  can't race each other's layout writes; the fetch/boot-load gating
 *  already happened inside useWorkspaceTabs. */
function useStaleTabPruning(
  staleTabIds: string[],
  layout: Parameters<typeof removeTabFromLayout>[0],
  handleLayoutChange: (layout: Parameters<typeof removeTabFromLayout>[0]) => void,
) {
  useEffect(() => {
    if (staleTabIds.length === 0) return;

    const sanitizedLayout = staleTabIds.reduce(
      (nextLayout, tabId) => removeTabFromLayout(nextLayout, tabId),
      layout,
    );

    handleLayoutChange(sanitizedLayout);
  }, [staleTabIds, layout, handleLayoutChange]);
}

/** Status-bar word count of the active document, null with nothing open. */
function useWordCount(content: string): number | null {
  return useMemo(() => {
    if (!content) return null;
    const words = content
      .trim()
      .split(/\s+/)
      .filter((word: string) => word.length > 0);
    return words.length;
  }, [content]);
}


/** Only file tabs are gated on the editor's format support; the other tab
 *  kinds carry their own content. */
function canOpenFileInTab(file: { type: string; path: string }): boolean {
  return file.type === "file" && canOpenInEditor(file.path);
}

/** Workspace-scoped lifecycle: access guard, navigation persistence, and
 *  teardown on leaving (editors disposed; agent runtimes torn down — their
 *  rows persist and demote to "restored", the tasks collection is
 *  storage-backed, MET-54). */
function useWorkspaceLifecycle(workspacePath: string): void {
  useThrowWorkspaceAccessError(workspacePath);
  useNavigationPersistence();
  useEffect(() => {
    return () => {
      disposeAllEditors();
    };
  }, []);
  useEffect(() => {
    return () => {
      void disposeWorkspaceTaskManager(workspacePath);
    };
  }, [workspacePath]);
}

/** Everything derived from the open tabs' backing rows: the cross-entity
 *  join (agent/file split, metadata ⋈ content rows, stale-tab detection),
 *  the rendered tab elements, watchers, and the status bar's inputs. */
function useWorkspaceDocuments({
  workspacePath,
  openTabs,
  activeTabId,
  layout,
  handleLayoutChange,
  closeTab,
  openFile,
}: {
  workspacePath: string;
  openTabs: string[];
  activeTabId: string | null;
  layout: Parameters<typeof removeTabFromLayout>[0];
  handleLayoutChange: (layout: Parameters<typeof removeTabFromLayout>[0]) => void;
  closeTab: (tabId: string) => void;
  openFile: (options: OpenFileInLayoutOptions) => void;
}) {
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
  const wordCount = useWordCount(activeFileData?.content || "");

  const isFetchingContent = useContentFetching(workspacePath);
  useStaleTabPruning(staleTabIds, layout, handleLayoutChange);
  useFileWatchers(workspacePath, fileOpenTabIds);

  return { allDockableTabs, wordCount, isSynced: !isFetchingContent };
}

/** The workspace's chrome state: sidebar/panel controls, the command
 *  palette's open flag, and the persisted text direction. */
function useWorkspaceChrome(
  workspacePath: string,
  searchPanelRef: React.RefObject<SearchPanelHandle | null>,
  focusActiveTab: () => boolean,
) {
  const panels = useWorkspacePanels({ searchPanelRef, focusActiveTab });
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const { direction, setDirection } = useDirectionSetting(workspacePath);
  return {
    ...panels,
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    direction,
    setDirection,
  };
}

/** The workspace's command surface: open-as-tab entry points, the command
 *  bundle behind the palette and hotkeys, the open-file rename, and the
 *  file tree's transient mode. */
function useWorkspaceActions({
  workspacePath,
  activeTabId,
  getFocusedTabId,
  getSelectedText,
  openSidebarIfCollapsed,
  openSearchPanel,
  openSessionsSidebar,
  openFile,
  renameTab,
}: {
  workspacePath: string;
  activeTabId: string | null;
  getFocusedTabId: () => string | null;
  getSelectedText: () => string | undefined;
  openSidebarIfCollapsed: () => void;
  openSearchPanel: () => void;
  openSessionsSidebar: () => void;
  openFile: (options: OpenFileInLayoutOptions) => void;
  renameTab: (oldId: string, newId: string) => void;
}) {
  const { openFileInTabs, openAgentTab } = useWorkspaceFileOpeners(openFile);
  const [fileTreeMode, setFileTreeMode] =
    useState<FileTreeMode>(FILE_TREE_IDLE);

  const commands = useWorkspaceCommands({
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

  const handleRenameOpenFile = useRenameOpenFile(workspacePath, renameTab);

  return {
    openFileInTabs,
    openAgentTab,
    handleRenameOpenFile,
    fileTreeMode,
    setFileTreeMode,
    ...commands,
  };
}

/** Rename/move a file while its tab is open — the close-and-reopen
 *  primitive keeps the tab in its window slot. */
function useRenameOpenFile(
  workspacePath: string,
  renameTab: (oldId: string, newId: string) => void,
) {
  return useCallback(
    (oldPath: string, newPath: string) =>
      renameOpenFileTab({
        workspacePath,
        oldPath,
        newPath,
        applyLayoutRename: renameTab,
      }),
    [workspacePath, renameTab],
  );
}

/** The dock's tab surface, or the empty-state message with no tabs open. */
function DockArea({
  hasTabs,
  layout,
  onLayoutChange,
  children,
}: {
  hasTabs: boolean;
  layout: Parameters<typeof removeTabFromLayout>[0];
  onLayoutChange: (layout: Parameters<typeof removeTabFromLayout>[0]) => void;
  children: React.ComponentProps<typeof Dockable.Root>["children"];
}) {
  const { t } = useTranslation();
  if (!hasTabs) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground p-4 ps-0">
        <p className="text-center">{t("noFileSelected")}</p>
      </div>
    );
  }
  return (
    <Dockable.Root orientation="row" layout={layout} onChange={onLayoutChange}>
      {children}
    </Dockable.Root>
  );
}
