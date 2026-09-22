/**
 * The `?sidebarView` search param — which view the sidebar shows. A leaf:
 * both the panels hook and "open a project" (which selects the project's
 * files view) read and write it, and neither may import the other.
 */
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

