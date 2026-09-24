/**
 * The workspace shell's own URL state: which side panel is showing and
 * whether the settings modal is open (`?sidebar`, `?sidebarView`,
 * `?settings`). Like the layout, it lives in the URL so a workspace restores
 * exactly as it was left; unlike the layout it says nothing about tabs,
 * which is why it is its own hook rather than more state in `Workspace`.
 *
 * The sidebar has two kinds of view: "everything" — the command-center
 * view over every open workspace — and the focused workspace's tools
 * (files, search, git, sessions). Which workspace is focused is a row
 * attribute of the open set, not URL state; the URL only says which tool
 * of it is showing.
 */
import { useCallback, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import type { SearchPanelHandle } from "@/components/editor/search-panel";
import { retryOnAnimationFrame } from "@/utils/retry-on-animation-frame";
import { DEFAULT_SETTINGS_SECTION } from "@/components/editor/settings-modal";
import { showWorkspace } from "@/hooks/use-open-project";
import { workspaceScoped } from "@/entities/workspace-scoped";

import {
  SIDEBAR_VIEW_PARAM,
  WORKSPACE_TOOLS,
  readSidebarView,
  withSidebarView,
  type SidebarView,
  type WorkspaceTool,
} from "@/hooks/sidebar-view";
export {
  WORKSPACE_TOOLS,
  readSidebarView,
  withSidebarView,
  type SidebarView,
  type WorkspaceTool,
};
/** The tool a workspace lands on when it has no remembered one. */
const DEFAULT_TOOL: WorkspaceTool = "files";

/**
 * The tool each workspace was last using, so returning to a workspace from
 * the rail lands on it (git for the one you were committing in, sessions
 * for the one you were prompting). Lives as long as the workspace is open:
 * a restart, or a close, lands it on files.
 */
const lastTool = workspaceScoped({
  create: (): { tool: WorkspaceTool } => ({ tool: DEFAULT_TOOL }),
});

export interface WorkspacePanelsOptions {
  /** The focused workspace — whose tool the URL's view belongs to. */
  workspacePath: string;
  searchPanelRef: RefObject<SearchPanelHandle | null>;
  /** Where focus goes when the sidebar closes: back into the active tab. */
  focusActiveTab: () => boolean;
}

export interface WorkspacePanels {
  sidebarView: SidebarView;
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  /** Expand the sidebar if collapsed (file creation lands in the tree). */
  openSidebarIfCollapsed: () => void;
  openSettings: () => void;
  /** Show `view`, expanding the sidebar if it was collapsed. */
  showSidebarView: (view: SidebarView) => void;
  /** The command-center view over every open workspace. */
  showEverything: () => void;
  /** Bring `path` to the front and show the tool it was last using. */
  showWorkspaceTools: (path: string) => void;
  /** Show the search panel and focus its input, seeded with the query. */
  openSearchPanel: (options?: {
    filePattern?: string;
    initialQuery?: string;
  }) => void;
  /** Mod+Shift+A — the agent sessions menu in the left sidebar. */
  openSessionsSidebar: () => void;
}

export function useWorkspacePanels({
  workspacePath,
  searchPanelRef,
  focusActiveTab,
}: WorkspacePanelsOptions): WorkspacePanels {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";
  const sidebarView = readSidebarView(searchParams);

  const showSidebarView = useCallback(
    (view: SidebarView) => {
      if (view !== "everything") {
        const remembered = lastTool.get(workspacePath);
        if (remembered) remembered.tool = view;
      }
      setUrlSearchParams((prev) => withSidebarView(prev, view), {
        replace: true,
      });
    },
    [setUrlSearchParams, workspacePath],
  );

  const showEverything = useCallback(
    () => showSidebarView("everything"),
    [showSidebarView],
  );

  const showWorkspaceTools = useCallback(
    (path: string) => {
      const tool = lastTool.peek(path)?.tool ?? DEFAULT_TOOL;
      // Focus is a durable write; the view flips at once.
      void showWorkspace(path);
      setUrlSearchParams((prev) => withSidebarView(prev, tool), {
        replace: true,
      });
    },
    [setUrlSearchParams],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    const isClosing = !isSidebarCollapsed;

    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("sidebar") === "collapsed") {
          next.delete("sidebar");
        } else {
          next.set("sidebar", "collapsed");
          next.delete(SIDEBAR_VIEW_PARAM);
        }
        return next;
      },
      { replace: true },
    );

    if (!isClosing) return;

    // The sidebar is going away — don't leave focus on a control inside it.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-sidebar]")) {
      active.blur();
    }
    retryOnAnimationFrame(focusActiveTab);
  }, [isSidebarCollapsed, setUrlSearchParams, focusActiveTab]);

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

  const openSettings = useCallback(() => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("settings", DEFAULT_SETTINGS_SECTION);
        return next;
      },
      { replace: true },
    );
  }, [setUrlSearchParams]);

  const openSearchPanel = useCallback(
    (options?: { filePattern?: string; initialQuery?: string }) => {
      showSidebarView("search");

      // The panel may still be mounting — retry until its input is there.
      retryOnAnimationFrame(() => {
        if (!searchPanelRef.current) return false;
        searchPanelRef.current.focusInput({
          filePattern: options?.filePattern,
          initialQuery: options?.initialQuery,
        });
        return true;
      });
    },
    [showSidebarView, searchPanelRef],
  );

  const openSessionsSidebar = useCallback(
    () => showSidebarView("sessions"),
    [showSidebarView],
  );

  return {
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
  };
}
