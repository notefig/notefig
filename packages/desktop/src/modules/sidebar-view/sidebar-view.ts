/**
 * The `?sidebarView` search param — which view the sidebar shows. Read and
 * written by the panels hook and by `sidebarViewModule` below, which
 * shows a workspace's files when the user enters it.
 */
import { defineModule } from "@notefig/core";
export const WORKSPACE_TOOLS = ["files", "search", "git", "sessions"] as const;
export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];
export type SidebarView = "everything" | WorkspaceTool;

export const SIDEBAR_VIEW_PARAM = "sidebarView";
/** Absent param = the Everything view: the sidebar opens on the overview
 *  unless something else was selected. */
const DEFAULT_VIEW: SidebarView = "everything";

function isSidebarView(value: string | null): value is SidebarView {
  return value === "everything" || WORKSPACE_TOOLS.includes(value as WorkspaceTool);
}

/** The view the URL names, defaulting past anything unrecognised. */
export function readSidebarView(params: URLSearchParams): SidebarView {
  const value = params.get(SIDEBAR_VIEW_PARAM);
  return isSidebarView(value) ? value : DEFAULT_VIEW;
}

/** Name `view` in the params (the default view is the absent param) and
 *  make sure the sidebar is expanded to show it. */
export function withSidebarView(
  prev: URLSearchParams,
  view: SidebarView,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (view === DEFAULT_VIEW) {
    next.delete(SIDEBAR_VIEW_PARAM);
  } else {
    next.set(SIDEBAR_VIEW_PARAM, view);
  }
  next.delete("sidebar");
  return next;
}


declare module "@notefig/core" {
  interface CoreModules {
    "sidebar-view": undefined;
  }
}

/**
 * Entering a workspace is choosing it: a sidebar on the Everything view
 * (the default when nothing is chosen) moves to that workspace's files; a
 * sidebar already on a tool stays on it. Read from and written to the live
 * URL, so it keeps whatever the entry's other handlers wrote (a tab landing
 * in the layout).
 */
export const sidebarViewModule = defineModule({
  name: "sidebar-view",
  needs: ["url"],
  boot: (_api, ctx) => {
    const url = ctx.use("url");
    return ctx.hooks.on("workspace:entered", () => {
      const live = new URLSearchParams(url.search());
      if (readSidebarView(live) !== "everything") return;
      url.setSearch(`?${withSidebarView(live, "files")}`, { replace: true });
    });
  },
});

/**
 * The tool a workspace was last using — `core.workspace(ws).lastTool` — so
 * returning to a workspace from the rail lands on it (git for the one you
 * were committing in, sessions for the one you were prompting). Lives as
 * long as the workspace is open: a restart, or a close, lands it on files.
 */
export interface LastTool {
  tool: WorkspaceTool;
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    lastTool: LastTool;
  }
}

export const lastToolModule = defineModule({
  name: "lastTool",
  workspace: { create: (): LastTool => ({ tool: "files" }) },
});
