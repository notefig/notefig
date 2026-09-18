import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type Ref,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  Folder,
  PanelLeft,
  PanelLeftClose,
  Settings,
} from "lucide-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import { cn } from "@notefig/ui/utils";
import { PlainLogo } from "@/components/logo";
import { FileTree, type FileTreeMode } from "@/components/editor/file-tree";
import {
  FileControls,
  FileCreateActions,
} from "@/components/editor/file-controls";
import {
  SearchPanel,
  type SearchPanelHandle,
} from "@/components/editor/search-panel";
import { EverythingPanel } from "@/components/editor/everything-panel";
import { TOOL_ICONS, TOOL_LABEL_KEYS } from "@/components/editor/workspace-tools";
import { SessionsPanel } from "@/components/agent/sessions-panel";
import { CheckpointPanel } from "@/components/editor/git/checkpoint-panel";
import {
  useFileCollections,
  deleteFileOrDirectory,
  renameFileOrDirectory,
  createFile,
  createDirectory,
} from "@/entities/files";
import { useAgentRunsOverview } from "@/entities/agents";
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
import { workspaceKey } from "@/utils/path";

interface SidebarProps {
  workspacePath: string;
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
}

/**
 * The sidebar: one quiet column. The mark on top leads to the Everything
 * view over every open workspace; a project chosen there unfolds its
 * tools, and picking one swaps the column for that tool under a row that
 * leads back. Collapsed, only a slim strip with the mark and the toggle
 * remains. Views swap with a short fade so the change of subject reads
 * as a move, not a flicker.
 */
export function Sidebar({
  workspacePath,
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
}: SidebarProps) {
  const { t } = useTranslation();
  const { containerRef, sidebarWidth, handleResizeStart } = useSidebarResize();

  useHotkey("Mod+\\", () => {
    onToggleCollapse();
  });

  if (isCollapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 bg-muted/40 py-2">
        <IconButton label={t("everythingHint")} onClick={onShowEverything}>
          <PlainLogo size="1.125rem" fill="var(--logo)" />
        </IconButton>
        <div className="mt-auto flex flex-col gap-1">
          <IconButton label={t("expandSidebar")} onClick={onToggleCollapse}>
            <PanelLeft className="size-4" />
          </IconButton>
          <IconButton label={t("settings")} onClick={onOpenSettings}>
            <Settings className="size-4" />
          </IconButton>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        data-sidebar
        className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/40"
        style={{ width: sidebarWidth }}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 px-2">
          <IconButton
            label={t("everythingHint")}
            active={sidebarView === "everything"}
            onClick={onShowEverything}
          >
            <PlainLogo size="1.125rem" fill="var(--logo)" />
          </IconButton>
          <div className="flex-1" />
          <IconButton label={t("collapseSidebar")} onClick={onToggleCollapse}>
            <PanelLeftClose className="size-4" />
          </IconButton>
        </div>

        <div
          key={sidebarView}
          className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-start-1 duration-200 motion-reduce:animate-none"
        >
          {sidebarView === "everything" ? (
            <EverythingPanel
              workspacePath={workspacePath}
              activeTabId={activeTabId}
              onShowWorkspaceTools={onShowWorkspaceTools}
              onShowTool={onShowTool}
            />
          ) : (
            <WorkspacePanel
              workspacePath={workspacePath}
              tool={sidebarView}
              onShowEverything={onShowEverything}
              onShowTool={onShowTool}
            >
              {sidebarView === "search" ? (
                <SearchPanel
                  ref={searchPanelRef}
                  workspacePath={workspacePath}
                />
              ) : sidebarView === "git" ? (
                <CheckpointPanel workspacePath={workspacePath} />
              ) : sidebarView === "sessions" ? (
                <SessionsPanel
                  workspacePath={workspacePath}
                  activeTabId={activeTabId}
                />
              ) : (
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
              )}
            </WorkspacePanel>
          )}
        </div>

        <div className="shrink-0 border-t border-border/60 px-2 py-1.5">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Settings className="size-4" />
            <span>{t("settings")}</span>
          </button>
        </div>
      </div>
      <div
        onMouseDown={handleResizeStart}
        className="w-0.5 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/50"
      />
    </>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
            active && "bg-accent text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// Widths in rem so they track the root font-size (app-wide UI scale).
const SIDEBAR_DEFAULT_REM = 16;
const SIDEBAR_MIN_REM = 11;
const SIDEBAR_MAX_REM = 26;

/** Drag-to-resize, measured from the column's own left edge. */
function useSidebarResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(`${SIDEBAR_DEFAULT_REM}rem`);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      const remPx = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const clampedRem = Math.max(
        SIDEBAR_MIN_REM,
        Math.min(SIDEBAR_MAX_REM, (e.clientX - left) / remPx),
      );
      setSidebarWidth(`${clampedRem}rem`);
    };
    const handleMouseUp = () => setIsResizing(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
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

  return { containerRef, sidebarWidth, handleResizeStart };
}

/**
 * The focused workspace's frame around whichever tool is showing: a row
 * back to Everything, the workspace's name, the tools as pill tabs, the
 * tool itself, and — when runs in this workspace need the user — a footer
 * saying so.
 */
function WorkspacePanel({
  workspacePath,
  tool,
  onShowEverything,
  onShowTool,
  children,
}: {
  workspacePath: string;
  tool: WorkspaceTool;
  onShowEverything: () => void;
  onShowTool: (tool: WorkspaceTool) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { byWorkspace } = useAgentRunsOverview();
  const hereCount = byWorkspace.get(workspaceKey(workspacePath))?.attention ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={onShowEverything}
          className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronLeft className="size-3.5 rtl:rotate-180" />
          <span className="truncate">{t("everything")}</span>
        </button>
        <div
          className="flex h-8 items-center gap-2.5 px-2 text-sm font-medium"
          title={workspacePath}
        >
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {deriveProjectName(workspacePath)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {WORKSPACE_TOOLS.map((candidate) => {
            const Icon = TOOL_ICONS[candidate];
            const active = candidate === tool;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => onShowTool(candidate)}
                aria-label={t(TOOL_LABEL_KEYS[candidate])}
                aria-pressed={active}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors",
                  active
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                <span>{t(TOOL_LABEL_KEYS[candidate])}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
        {children}
      </div>

      {hereCount > 0 && (
        <button
          type="button"
          onClick={onShowEverything}
          className="flex h-8 shrink-0 items-center gap-2.5 border-t border-border/60 px-4 text-sm transition-colors hover:bg-accent/60 animate-in fade-in-0 duration-200 motion-reduce:animate-none"
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-destructive"
          />
          <span className="min-w-0 flex-1 truncate text-start">
            {t("runsNeedYouHere", { count: hereCount })}
          </span>
        </button>
      )}
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
        <FileCreateActions
          onNewScratchpad={handleNewScratchpad}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
        />
      </div>
      <FileControls
        workspacePath={workspacePath}
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
      />
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
