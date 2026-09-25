import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type React from "react";
import { Dockable } from "@/components/dockable";
import type { DockChrome } from "@/components/dockable/store";
import { CollapsedSidebarHeader, Sidebar } from "@/components/editor/sidebar";
import type { SearchPanelHandle } from "@/components/editor/search-panel";
import { canOpenFile as canOpenInEditor } from "@/components/editor/polymorphic-editor";
import { StatusBar } from "@/components/editor/status-bar";
import {
  SHELL_CARD_CLASS,
  Titlebar,
  WindowsControlsInline,
  useShellChromeMetrics,
} from "@/components/titlebar";
import { cn } from "@notefig/ui/utils";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import {
  getOrCreateWorkspaceCollections,
  refetchWorkspaceMetadata,
  useContentFetching,
  useOpenFileRows,
} from "@/entities/files";
import { syncContentWatchers } from "@/utils/file-sync";
import {
  openWorkspacesCollection,
  useFocusedWorkspace,
  useOpenWorkspacesReady,
  useWorkspaceOfPath,
  workspaceOfPath,
} from "@/entities/workspaces";
import { useWorkspaceTabs, renameOpenFileTab } from "@/entities/tabs";
import { DebugPanel } from "./debug-panel";
import { useOpenProject } from "@/hooks/use-open-project";
import { Welcome } from "@/components/welcome";
import { platformAdapter } from "@/adapters";
import { usePublishAppStatus } from "@/hooks/use-app-status";
import { useProjectSettings } from "@/utils/project-settings";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import { useWorkspaceCommands } from "@/hooks/use-workspace-commands";
import { useWorkspacePanels } from "@/hooks/use-workspace-panels";
import { useSidebarResize } from "@/hooks/use-sidebar-resize";
import { useSidebarCollapseTween } from "@/hooks/use-sidebar-collapse-tween";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { WorkspaceTabsProvider } from "@/components/workspace-tabs-provider";
import { PromptWidgetBoundary } from "@/components/agent/prompt-widget-boundary";
import { useThrowWorkspaceAccessError } from "@/components/workspace-error-boundary";
import { agentTabId, isFileTabId, tabKind } from "@/entities/tabs";
import { touchRecentDocument } from "@/entities/recent-documents";
import { useTrackActiveTab } from "@/entities/seen";
import { useTabElements } from "@/tabs/tab-types";
import { useReleaseNotesOnUpdate } from "@/hooks/use-release-notes-on-update";
import {
  type FileTreeMode,
  FILE_TREE_IDLE,
} from "@/components/editor/file-tree";

/**
 * The app at "/": the dock over every open workspace, with the sidebar
 * showing the focused one — or the welcome screen with nothing open. Waits
 * for the persisted open set so a restored session never flashes welcome.
 */
export const Workspace = () => {
  const ready = useOpenWorkspacesReady();
  const focusedWorkspace = useFocusedWorkspace();
  useOpenProjectFromHost();
  useOpenProjectTestSeam();

  if (!ready) return null;
  if (focusedWorkspace === null) {
    return (
      <div className="flex h-full flex-col">
        <Titlebar />
        <div className="min-h-0 flex-1">
          <Welcome />
        </div>
      </div>
    );
  }
  return <WorkspaceShell workspacePath={focusedWorkspace} />;
};

/** The native "Open Folder" menu item (Rust emits `folder-selected`). */
function useOpenProjectFromHost(): void {
  const openProject = useOpenProject();
  useEffect(
    () =>
      platformAdapter.ui.addEventListener((event) => {
        if (event.type === "folder-selected") void openProject(event.payload);
      }),
    [openProject],
  );
}

/**
 * Test seam: the e2e suites open workspaces through this rather than the
 * native folder picker, which neither the browser adapter's mock nor the
 * real-backend shim can drive for a given path. Dev/test builds only.
 */
function useOpenProjectTestSeam(): void {
  const openProject = useOpenProject();
  useEffect(() => {
    if (!import.meta.env.DEV && !import.meta.env.VITE_TEST_BACKEND) return;
    (window as Window & { __notefigTest?: unknown }).__notefigTest = {
      openProject,
      openWorkspaces: () =>
        [...openWorkspacesCollection.values()].map((row) => row.path),
      metadataPaths: (workspacePath: string) =>
        getOrCreateWorkspaceCollections(workspacePath).metadata.toArray.map(
          (row) => row.path,
        ),
      refetchMetadata: (workspacePath: string) =>
        refetchWorkspaceMetadata(workspacePath),
    };
  }, [openProject]);
}

/** The workspace surface: `workspacePath` is the focused workspace — what
 *  the sidebar shows and new-item actions target. The dock is not scoped
 *  by it; every tab resolves its own workspace. */
function WorkspaceShell({ workspacePath }: { workspacePath: string }) {
  useThrowWorkspaceAccessError(workspacePath);
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
    openTabs,
    activeTabId,
    layout,
    handleLayoutChange,
    closeTab,
    openFile,
  });

  const {
    sidebarView,
    isSidebarCollapsed,
    toggleSidebarCollapsed,
    openSidebarIfCollapsed,
    openSettings,
    showSidebarView,
    showEverything,
    showWorkspaceTools,
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

  // What the platform shows outside the window follows this shell.
  const appStatusTabs = useMemo(
    () => ({ openFile: openFileInTabs, openAgentTab }),
    [openFileInTabs, openAgentTab],
  );
  usePublishAppStatus({ workspacePath, tabs: appStatusTabs, openSettings });

  const chrome = useShellChromeMetrics();
  // Search follows the file in front of the user, not the sidebar's
  // workspace: the two differ once tabs from several workspaces share
  // the dock.
  const activeFileWorkspace = useWorkspaceOfPath(
    activeFilePath(activeTabId) ?? "",
  );
  const searchWorkspacePath = activeFileWorkspace ?? workspacePath;
  const sidebarResize = useSidebarResize();
  const sidebarTween = useSidebarCollapseTween(isSidebarCollapsed);
  // The macOS lights sit at the window's physical top-left: over the
  // sidebar in LTR, over the dock's end-most tab bar in RTL.
  const lightsInset = direction === "rtl" ? undefined : chrome.insetStart;

  return (
    <WorkspaceTabsProvider
      openFile={openFileInTabs}
      openAgentTab={openAgentTab}
    >
      <PromptWidgetBoundary>
        <div
          dir={direction}
          className={cn(
            // `relative` so the status bar's corner is the window's, not the
            // padded dock column's: the root's overflow clip ends at its
            // padding edge, so bottom-0 here hugs the window's bottom.
            "texture-surface relative flex h-full w-full overflow-clip bg-background",
            chrome.rootClassName,
          )}
          style={chrome.rootStyle}
        >
          <Sidebar
            workspacePath={workspacePath}
            searchWorkspacePath={searchWorkspacePath}
            sidebarView={sidebarView}
            isCollapsed={isSidebarCollapsed}
            activeTabId={activeTabId}
            openTabs={openTabs}
            onFileSelect={handleFileSelect}
            closeTab={closeTab}
            onRenameOpenFile={handleRenameOpenFile}
            mode={fileTreeMode}
            onModeChange={setFileTreeMode}
            searchPanelRef={searchPanelRef}
            onToggleCollapse={toggleSidebarCollapsed}
            onShowEverything={showEverything}
            onShowTool={showSidebarView}
            onShowWorkspaceTools={showWorkspaceTools}
            onOpenSettings={openSettings}
            resize={sidebarResize}
            tween={sidebarTween}
            lightsInset={lightsInset}
          />

          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col overflow-clip",
              chrome.stackClassName,
            )}
            style={chrome.stackStyle}
          >
            <div className="relative flex min-h-0 flex-1 flex-col overflow-clip">
              <DebugPanel />
              <div className="flex min-h-0 flex-1 overflow-clip">
                <div
                  ref={dockableRef}
                  className="h-full min-w-0 flex-1 overflow-clip"
                  tabIndex={-1}
                >
                  <DockArea
                    hasTabs={openTabs.length > 0}
                    layout={layout}
                    onLayoutChange={handleLayoutChange}
                    chrome={{
                      tabBarLeading: (
                        <CollapsedSidebarHeader
                          workspacePath={workspacePath}
                          width={sidebarResize.sidebarWidth}
                          open={!isSidebarCollapsed}
                          lightsInset={lightsInset}
                          onToggleCollapse={toggleSidebarCollapsed}
                        />
                      ),
                      tabBarTrailing: <WindowsControlsInline />,
                      tabBarLeadingActive: isSidebarCollapsed,
                      endInset:
                        direction === "rtl"
                          ? (chrome.insetStart ?? null)
                          : null,
                    }}
                  >
                    {allDockableTabs}
                  </DockArea>
                </div>
              </div>
            </div>
          </div>

          <StatusBar
            wordCount={wordCount}
            isSynced={isSynced}
            direction={direction}
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
}

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
  handleLayoutChange: (
    layout: Parameters<typeof removeTabFromLayout>[0],
  ) => void,
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

/** The active tab's file content, "" unless a file tab is active and its
 *  content has loaded. Joined here, not lifted from the tab: the active tab
 *  resolves its own workspace like every file tab does. */
function useActiveFileContent(activeTabId: string | null): string {
  const activePath = activeFilePath(activeTabId);
  // No file tab active → no workspace contains "" → no rows, no query.
  const workspacePath = useWorkspaceOfPath(activePath ?? "");
  const paths = useMemo(
    () => (activePath === null ? [] : [activePath]),
    [activePath],
  );
  const [row] = useOpenFileRows(workspacePath, paths);
  return row?.content ?? "";
}

function activeFilePath(activeTabId: string | null): string | null {
  if (activeTabId === null || !isFileTabId(activeTabId)) return null;
  return activeTabId;
}

/** Status-bar word count, null with nothing to count. */
function countWords(content: string): number | null {
  if (!content) return null;
  return content
    .trim()
    .split(/\s+/)
    .filter((word: string) => word.length > 0).length;
}

/** Only file tabs are gated on the editor's format support; the other tab
 *  kinds carry their own content. */
function canOpenFileInTab(file: { type: string; path: string }): boolean {
  return file.type === "file" && canOpenInEditor(file.path);
}

/** Everything derived from the open tabs' backing rows: the cross-entity
 *  join (agent/file split, metadata ⋈ content rows, stale-tab detection),
 *  the rendered tab elements, watchers, and the status bar's inputs. */
function useWorkspaceDocuments({
  openTabs,
  activeTabId,
  layout,
  handleLayoutChange,
  closeTab,
  openFile,
}: {
  openTabs: string[];
  activeTabId: string | null;
  layout: Parameters<typeof removeTabFromLayout>[0];
  handleLayoutChange: (
    layout: Parameters<typeof removeTabFromLayout>[0],
  ) => void;
  closeTab: (tabId: string) => void;
  openFile: (options: OpenFileInLayoutOptions) => void;
}) {
  const {
    fileTabsByWorkspace,
    agentTaskRows: openAgentTaskRows,
    staleTabIds,
  } = useWorkspaceTabs(openTabs);

  useReleaseNotesOnUpdate(openFile);

  // One element per open tab, built from the tab-type registry (title +
  // content per kind) and memoised per tab id.
  const allDockableTabs = useTabElements(openTabs, {
    agentTaskRows: openAgentTaskRows,
    closeTab,
  });

  const activeContent = useActiveFileContent(activeTabId);
  const wordCount = useMemo(() => countWords(activeContent), [activeContent]);

  // The Everything view's recent documents: whatever file tab is in front.
  useEffect(() => {
    if (activeTabId !== null && isFileTabId(activeTabId)) {
      void touchRecentDocument(activeTabId);
    }
  }, [activeTabId]);
  // ...and the seen tracker: whatever tab is in front has been looked at.
  useTrackActiveTab(activeTabId);

  const isFetchingContent = useContentFetching();
  useStaleTabPruning(staleTabIds, layout, handleLayoutChange);
  useEffect(() => {
    syncContentWatchers(fileTabsByWorkspace);
  }, [fileTabsByWorkspace]);
  useEffect(() => () => syncContentWatchers(new Map()), []);

  return { allDockableTabs, wordCount, isSynced: !isFetchingContent };
}

/** The workspace's chrome state: sidebar/panel controls, the command
 *  palette's open flag, and the persisted text direction. */
function useWorkspaceChrome(
  workspacePath: string,
  searchPanelRef: React.RefObject<SearchPanelHandle | null>,
  focusActiveTab: () => boolean,
) {
  const panels = useWorkspacePanels({
    workspacePath,
    searchPanelRef,
    focusActiveTab,
  });
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
        // The tab belongs to the workspace that holds its file, which need
        // not be the one the sidebar shows.
        workspacePath: workspaceOfPath(oldPath) ?? workspacePath,
        oldPath,
        newPath,
        applyLayoutRename: renameTab,
      }),
    [workspacePath, renameTab],
  );
}

/** The dock's tab surface, or the empty-state message with no tabs open.
 *  The header row (the top-left tab bar, host of the collapsed sidebar's
 *  header) is there in both, so the content never moves. */
function DockArea({
  hasTabs,
  layout,
  onLayoutChange,
  chrome,
  children,
}: {
  hasTabs: boolean;
  layout: Parameters<typeof removeTabFromLayout>[0];
  onLayoutChange: (layout: Parameters<typeof removeTabFromLayout>[0]) => void;
  chrome: Partial<DockChrome>;
  children: React.ComponentProps<typeof Dockable.Root>["children"];
}) {
  const { t } = useTranslation();
  if (!hasTabs) {
    return (
      <div className="flex h-full flex-col">
        <div
          className={cn(
            SHELL_CARD_CLASS,
            "flex h-[calc(var(--shell-header-height)+2px)] shrink-0 overflow-clip rounded-lg transition-[margin] duration-200 ease-out motion-reduce:transition-none",
            chrome.tabBarLeadingActive ? "ms-0 me-2" : "mx-2",
          )}
        >
          {chrome.tabBarLeading}
          <div className="flex-1" />
          {chrome.endInset != null && (
            <div className="shrink-0" style={{ width: chrome.endInset }} />
          )}
          {chrome.tabBarTrailing}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-muted-foreground">
          <p className="text-center">{t("noFileSelected")}</p>
        </div>
      </div>
    );
  }
  return (
    <Dockable.Root
      orientation="row"
      layout={layout}
      onChange={onLayoutChange}
      chrome={chrome}
    >
      {children}
    </Dockable.Root>
  );
}
