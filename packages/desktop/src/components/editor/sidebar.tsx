import {
  useState,
  useEffect,
  useCallback,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { cn } from "@notefig/ui/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import {
  SHELL_CARD_CLASS,
  SHELL_HEADER_HEIGHT_CLASS,
  SHELL_CHROME_WASH_CLASS,
  ShellHeaderCard,
} from "@/components/titlebar";
import type { SidebarResize } from "@/hooks/use-sidebar-resize";
import type { SidebarCollapseTween } from "@/hooks/use-sidebar-collapse-tween";
import { FileTree, type FileTreeMode } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import {
  SearchPanel,
  type SearchPanelHandle,
} from "@/components/editor/search-panel";
import { EverythingPanel } from "@/components/editor/everything-panel";
import { GlobalColumn } from "@/components/editor/global-column";
import {
  TOOL_ICONS,
  TOOL_LABEL_KEYS,
} from "@/components/editor/workspace-tools";
import { SidebarSeparator } from "@/components/editor/tool-bar";
import { SessionsPanel } from "@/components/agent/sessions-panel";
import { CheckpointPanel } from "@/components/editor/git/checkpoint-panel";
import {
  useFileCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  createFile,
  createDirectory,
} from "@/entities/files";
import { useAttention } from "@/entities/attention";
import {
  StatusGlyph,
  attentionGlyphState,
} from "@/components/agent/status-glyph";
import {
  ensureNewFileNameHasDefaultMarkdownExtension,
  getDirectoryPath,
  isTextFile,
} from "@/utils/fs";
import type { FileTreeNode, SortOrder } from "@/utils/fs";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { requestElementFocus } from "@/utils/focus-arbiter";
import { grantTabFocusHandoff } from "@/tabs/tab-controllers";
import { createAndOpenScratchpad } from "@/entities/scratchpads";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { deriveProjectName } from "@/hooks/use-recent-projects";
import {
  WORKSPACE_TOOLS,
  type SidebarView,
  type WorkspaceTool,
} from "@/hooks/use-workspace-panels";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

interface SidebarProps {
  workspacePath: string;
  /** What the search tool searches: the active file's workspace when a
   *  file is open, else the focused one. Searching the sidebar's
   *  workspace while reading a file from another read as a bug. */
  searchWorkspacePath: string;
  sidebarView: SidebarView;
  isCollapsed: boolean;
  activeTabId: string | null;
  openTabs: string[];
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => boolean;
  closeTab: (tabId: string) => void;
  /** Rename/move a file whose tab is open (close-and-reopen primitive). */
  onRenameOpenFile: (oldPath: string, newPath: string) => Promise<void>;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
  searchPanelRef?: Ref<SearchPanelHandle>;
  onToggleCollapse: () => void;
  onShowEverything: () => void;
  onShowTool: (tool: WorkspaceTool) => void;
  onShowWorkspaceTools: (path: string) => void;
  onOpenSettings: () => void;
  /** Owned by the shell so the collapsed header keeps the same width. */
  resize: SidebarResize;
  /** Owned by the shell; the tab-bar header tweens against it. */
  tween: SidebarCollapseTween;
  /** Clearance for the macOS lights at the header's start, when the
   *  sidebar is what they overlap (LTR on macOS); undefined otherwise. */
  lightsInset: number | undefined;
}

/**
 * The sidebar: one floating card that owns the window's header row. Closed,
 * only that header remains — the OS lights, the focused workspace's name,
 * an attention dot and the open button — pinned into the dock's tab bar.
 * Open, the same header sits on top and the rest unrolls beneath it: the
 * global rail down the left (logo = Everything, the open workspaces, +,
 * settings) beside the tool tabs and the tool (or the Everything view),
 * and a footer with the agent run counts. The header never moves between
 * the two. Tool switches swap content instantly — no fade, which read as
 * jank.
 */
export function Sidebar({
  workspacePath,
  searchWorkspacePath,
  sidebarView,
  isCollapsed,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  onRenameOpenFile,
  mode,
  onModeChange,
  searchPanelRef,
  onToggleCollapse,
  onShowEverything,
  onShowTool,
  onShowWorkspaceTools,
  onOpenSettings,
  resize,
  tween,
  lightsInset,
}: SidebarProps) {
  const { containerRef, sidebarWidth, handleResizeStart } = resize;

  useHotkey("Mod+\\", () => {
    onToggleCollapse();
  });

  const { rendered, expanded } = tween;
  // Collapsed and done tweening, the sidebar has no column at all: the
  // shell lays its header into the dock's tab bar (`CollapsedSidebarHeader`).
  if (!rendered) return null;

  return (
    <div
      ref={containerRef}
      data-sidebar
      className="relative flex min-h-0 shrink-0 flex-col overflow-hidden transition-[width,margin] duration-200 ease-out motion-reduce:transition-none"
      style={{
        width: expanded ? sidebarWidth : 0,
        // Give the gap back while closed so the dock lands flush.
        marginInlineEnd: expanded ? 0 : "calc(var(--shell-gap) * -1)",
      }}
    >
      <div
        className={cn(
          SHELL_CARD_CLASS,
          "texture-surface",
          "flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-200 motion-reduce:transition-none",
          expanded ? "opacity-100" : "opacity-0",
        )}
        // Fixed to the open width so nothing inside reflows mid-tween.
        style={{ width: sidebarWidth }}
      >
        <SidebarHeaderRow
          workspacePath={workspacePath}
          lightsInset={lightsInset}
          onToggleCollapse={onToggleCollapse}
        />
        <SidebarBody
          workspacePath={workspacePath}
          searchWorkspacePath={searchWorkspacePath}
          sidebarView={sidebarView}
          activeTabId={activeTabId}
          openTabs={openTabs}
          onFileSelect={onFileSelect}
          closeTab={closeTab}
          onRenameOpenFile={onRenameOpenFile}
          mode={mode}
          onModeChange={onModeChange}
          searchPanelRef={searchPanelRef}
          onShowEverything={onShowEverything}
          onShowTool={onShowTool}
          onShowWorkspaceTools={onShowWorkspaceTools}
          onOpenSettings={onOpenSettings}
        />
      </div>
      {expanded && (
        <div
          data-resize-handle
          onMouseDown={handleResizeStart}
          className="absolute inset-y-0 end-0 w-2 cursor-col-resize"
        />
      )}
    </div>
  );
}

/** The card's header row: tinted, never ruled — the rules below belong to
 *  the tools (under the tool tabs) and to the Everything view's top block. */
function SidebarHeaderRow({
  workspacePath,
  lightsInset,
  onToggleCollapse,
}: Pick<SidebarProps, "workspacePath" | "lightsInset" | "onToggleCollapse">) {
  return (
    <>
      <ShellHeaderCard
        className={cn(
          "rounded-none border-0 bg-transparent shadow-none",
          SHELL_CHROME_WASH_CLASS,
        )}
      >
        <SidebarHeader
          workspacePath={workspacePath}
          isCollapsed={false}
          lightsInset={lightsInset}
          onToggleCollapse={onToggleCollapse}
        />
      </ShellHeaderCard>
    </>
  );
}

/** Under the header: the global rail beside the Everything view or the
 *  focused workspace's tool tabs and tool. */
function SidebarBody({
  workspacePath,
  searchWorkspacePath,
  sidebarView,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  onRenameOpenFile,
  mode,
  onModeChange,
  searchPanelRef,
  onShowEverything,
  onShowTool,
  onShowWorkspaceTools,
  onOpenSettings,
}: Omit<
  SidebarProps,
  "isCollapsed" | "onToggleCollapse" | "resize" | "tween" | "lightsInset"
>) {
  const isEverything = sidebarView === "everything";
  return (
    <div className="flex min-h-0 flex-1">
      <GlobalColumn
        workspacePath={workspacePath}
        isEverything={isEverything}
        onShowEverything={onShowEverything}
        onShowWorkspaceTools={onShowWorkspaceTools}
        onOpenSettings={onOpenSettings}
      />
      <SidebarSeparator vertical />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isEverything ? (
          <EverythingPanel
            workspacePath={workspacePath}
            activeTabId={activeTabId}
          />
        ) : (
          <WorkspacePanel tool={sidebarView} onShowTool={onShowTool}>
            <ToolContent
              tool={sidebarView}
              workspacePath={workspacePath}
              searchWorkspacePath={searchWorkspacePath}
              activeTabId={activeTabId}
              openTabs={openTabs}
              onFileSelect={onFileSelect}
              closeTab={closeTab}
              onRenameOpenFile={onRenameOpenFile}
              mode={mode}
              onModeChange={onModeChange}
              searchPanelRef={searchPanelRef}
            />
          </WorkspacePanel>
        )}
      </div>
    </div>
  );
}

/** The focused workspace's tool, by name. */
function ToolContent({
  tool,
  workspacePath,
  searchWorkspacePath,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  onRenameOpenFile,
  mode,
  onModeChange,
  searchPanelRef,
}: { tool: WorkspaceTool } & Pick<
  SidebarProps,
  | "workspacePath"
  | "searchWorkspacePath"
  | "activeTabId"
  | "openTabs"
  | "onFileSelect"
  | "closeTab"
  | "onRenameOpenFile"
  | "mode"
  | "onModeChange"
  | "searchPanelRef"
>) {
  switch (tool) {
    case "search":
      return (
        <SearchPanel ref={searchPanelRef} workspacePath={searchWorkspacePath} />
      );
    case "git":
      return <CheckpointPanel workspacePath={workspacePath} />;
    case "sessions":
      return (
        <SessionsPanel
          workspacePath={workspacePath}
          activeTabId={activeTabId}
        />
      );
    default:
      return (
        <FilesTool
          workspacePath={workspacePath}
          activeTabId={activeTabId}
          openTabs={openTabs}
          onFileSelect={onFileSelect}
          closeTab={closeTab}
          onRenameOpenFile={onRenameOpenFile}
          mode={mode}
          onModeChange={onModeChange}
        />
      );
  }
}

/**
 * The collapsed sidebar: its header alone, laid into the start of the
 * dock's top tab bar so the dock takes the whole width. Always mounted
 * there: while the sidebar is open it is a zero-width, hidden slot, and
 * it tweens to the open sidebar's width as the column tweens away — so
 * the tabs after it glide instead of jumping. Same height, width and
 * inset as the open card's header, so the buttons never move.
 */
export function CollapsedSidebarHeader({
  workspacePath,
  width,
  open,
  lightsInset,
  onToggleCollapse,
}: {
  workspacePath: string;
  /** The open sidebar's width, so the buttons stay where they were. */
  width: string;
  /** The sidebar is open: collapse this to nothing. */
  open: boolean;
  lightsInset: number | undefined;
  onToggleCollapse: () => void;
}) {
  return (
    <div
      aria-hidden={open || undefined}
      className={cn(
        "flex shrink-0 select-none items-center overflow-hidden border-border transition-[width,visibility] duration-200 ease-out motion-reduce:transition-none",
        open ? "invisible" : "visible",
        SHELL_HEADER_HEIGHT_CLASS,
      )}
      // The open header sits inside the card's two 1px borders and this one
      // ends in a 1px separator: net 1px off, so the buttons land on the
      // same pixel in both states.
      style={{ width: open ? 0 : `calc(${width} - 1px)` }}
    >
      <div
        className="flex h-full shrink-0"
        style={{ width: `calc(${width} - 1px)` }}
      >
        <SidebarHeader
          workspacePath={workspacePath}
          isCollapsed
          lightsInset={lightsInset}
          onToggleCollapse={onToggleCollapse}
        />
        <SidebarSeparator vertical className="my-1.5" />
      </div>
    </div>
  );
}

/**
 * The header row: room for the macOS lights (a window drag region), then
 * one tab-like button — the focused workspace's name, one dot when
 * anything anywhere needs attention (amber if any of it is an error, else
 * the brand blue — never both), and the open/close glyph — that toggles
 * the sidebar wherever it is clicked. Closed, this row is all that is left
 * of the sidebar (pinned at the start of the dock's tab bar).
 */
function SidebarHeader({
  workspacePath,
  isCollapsed,
  lightsInset,
  onToggleCollapse,
}: {
  workspacePath: string;
  isCollapsed: boolean;
  lightsInset: number | undefined;
  onToggleCollapse: () => void;
}) {
  const { t } = useTranslation();
  const { overall } = useAttention();

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch">
      <div
        data-tauri-drag-region
        className="shrink-0"
        style={
          { WebkitAppRegion: "drag", width: lightsInset ?? 0 } as CSSProperties
        }
      />
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
        aria-pressed={!isCollapsed}
        title={workspacePath}
        className="flex min-w-0 flex-1 items-center gap-1.5 pe-1.5 ps-2.5 text-start transition-colors hover:bg-accent/60"
        style={NO_DRAG}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {deriveProjectName(workspacePath)}
        </span>
        {overall && (
          <StatusGlyph
            state={attentionGlyphState(overall)}
            className="animate-in zoom-in-50 duration-200 motion-reduce:animate-none"
          />
        )}
        <span
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            !isCollapsed && "bg-accent text-foreground",
          )}
        >
          {isCollapsed ? (
            <PanelLeft className="size-3.5" />
          ) : (
            <PanelLeftClose className="size-3.5" />
          )}
        </span>
      </button>
    </div>
  );
}

/**
 * The focused workspace's tools as a row of icon tabs (names in their
 * tooltips) over the tool itself.
 */
function WorkspacePanel({
  tool,
  onShowTool,
  children,
}: {
  tool: WorkspaceTool;
  onShowTool: (tool: WorkspaceTool) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-1.5">
        <div className="flex h-8 items-center gap-0.5">
          {WORKSPACE_TOOLS.map((candidate) => {
            const Icon = TOOL_ICONS[candidate];
            const active = candidate === tool;
            const label = t(TOOL_LABEL_KEYS[candidate]);
            return (
              <Tooltip key={candidate}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onShowTool(candidate)}
                    aria-label={label}
                    aria-pressed={active}
                    className={cn(
                      "flex h-5 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <SidebarSeparator className="mx-0" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** The file tree with its creation actions and sort control. */
function FilesTool({
  workspacePath,
  activeTabId,
  openTabs,
  onFileSelect,
  closeTab,
  onRenameOpenFile,
  mode,
  onModeChange,
}: Pick<
  SidebarProps,
  | "workspacePath"
  | "activeTabId"
  | "openTabs"
  | "onFileSelect"
  | "closeTab"
  | "onRenameOpenFile"
  | "mode"
  | "onModeChange"
>) {
  const { metadata } = useFileCollections(workspacePath);
  const { sortOrder, setSortOrder } = useSortOrder();
  const { openFile } = useWorkspaceTabs();

  useEffect(() => {
    if (mode.type !== "idle") return;

    requestElementFocus("sidebar-first-file-item", {
      domain: "sidebar",
      priority: 60,
      reason: "sidebar-open-focus-first-item",
      when: "when-mounted",
    });
  }, [mode.type]);

  // "New Scratchpad" is instant and nameless; "New File" starts the tree's
  // inline-naming flow at the workspace root (per-folder creation stays on
  // the context menu — both land in handleCreate).
  const handleNewScratchpad = useCallback(() => {
    createAndOpenScratchpad(workspacePath, openFile);
  }, [workspacePath, openFile]);

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
      const resolvedName =
        type === "file"
          ? ensureNewFileNameHasDefaultMarkdownExtension(name)
          : name;
      const fullPath = parentPath + "/" + resolvedName;

      const existing = metadata.get(fullPath);
      if (existing) {
        console.error(`Cannot create: "${fullPath}" already exists`);
        return;
      }

      if (type === "file") {
        createFile(workspacePath, fullPath)
          .then(() => {
            if (isTextFile(fullPath)) {
              const opened = onFileSelect({
                path: fullPath,
                type: "file",
                contentHash: "",
                content: "",
              });
              // The user's create gesture is what makes the new document
              // the entry point: the tree opens its inline rename at the
              // same moment, and the document's ambient claims (the prompt
              // widget's) would rightly stand down for that field. Grant
              // the hand-off here, where the gesture is — never from the
              // widget, which also mounts for documents the app opened
              // under the user's hands — and only for a tab that actually
              // entered the dock: a grant with no tab has no owner to
              // consume or drop it, and would upgrade whatever opened that
              // path next.
              if (opened) grantTabFocusHandoff(fullPath);
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
      // Rename is always in place; moving lives on the drag gesture.
      const newPath = getDirectoryPath(oldPath) + "/" + newName;
      if (oldPath === newPath) return;

      const existing = metadata.get(newPath);
      if (existing) {
        console.error(`Cannot rename: "${newPath}" already exists`);
        return;
      }

      // Open files route through the close-and-reopen primitive so the
      // tab follows the file.
      const rename = openTabs.includes(oldPath)
        ? onRenameOpenFile(oldPath, newPath)
        : renameFileOrDirectory(workspacePath, oldPath, newPath);
      rename.catch((error: unknown) => {
        console.error(`Failed to rename ${oldPath} to ${newPath}:`, error);
      });
    },
    [workspacePath, metadata, openTabs, onRenameOpenFile],
  );

  return (
    <>
      <FileControls
        workspacePath={workspacePath}
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
        onNewScratchpad={handleNewScratchpad}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
      />
      <div className="relative flex min-h-0 grow flex-col">
        <FileTree
          selectedFilePath={activeTabId}
          onFileSelect={onFileSelect}
          onDelete={handleDeleteFile}
          onRename={handleRenameFile}
          onRenameOpenFile={onRenameOpenFile}
          onCreate={handleCreate}
          openTabs={openTabs}
          basePath={workspacePath}
          sortOrder={sortOrder}
          mode={mode}
          onModeChange={onModeChange}
        />
      </div>
    </>
  );
}

/** The tree's sort order, in the URL like the rest of the shell's chrome. */
function useSortOrder() {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const sortOrder = (searchParams.get("sort") as SortOrder) || "name-asc";
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setUrlSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (order === "name-asc") {
          next.delete("sort");
        } else {
          next.set("sort", order);
        }
        return next;
      });
    },
    [setUrlSearchParams],
  );
  return { sortOrder, setSortOrder };
}
