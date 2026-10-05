/**
 * Projects — `core.projects`: opening, showing and closing a workspace as
 * the user means it, from anywhere (the welcome screen, the switcher, the
 * palette, the native menu, error recovery, the test seam).
 *
 * Opening a project: the workspace joins the open set and comes to the
 * front, and, when none of its files is open in the dock, its scratchpad
 * lands as a tab (MET-135's empty entry). Nothing navigates: the dock is
 * one layout over every open workspace, so opening a project adds to it
 * rather than replacing it.
 */
import { defineModule } from "@notefig/core";
import type { LayoutApi } from "./layout";
import { isFileTabId } from "./tabs";
import { closeWorkspace, openWorkspace, workspaceOfPath } from "./workspaces";
import { enterScratchpad, sweepScratchpads } from "./scratchpads";
import { readSidebarView, withSidebarView } from "@/hooks/sidebar-view";
import { ensureWatching } from "@/utils/workspace-watchers";
import { workspaceKey } from "@/utils/path";

export interface ProjectsApi {
  /**
   * Open-or-focus, land on something to read (the scratchpad, when none of
   * the project's files is open), and show its files in the sidebar.
   * Resolves once all of that is done. Calls for one project while one is
   * in flight join it.
   */
  open(workspacePath: string): Promise<void>;
  /**
   * Open-or-focus only: no scratchpad, no sidebar change. Also re-arms a
   * watcher whose start failed (the folder was unreadable when opened).
   */
  show(workspacePath: string): Promise<void>;
  /** Close it and free everything it holds; see `closeWorkspace`. */
  close(workspacePath: string): Promise<void>;
}

declare module "@notefig/core" {
  interface CoreModules {
    projects: ProjectsApi;
  }
}

/** Whether any file tab in the dock belongs to the workspace. */
function hasOpenFileTab(layout: LayoutApi, workspacePath: string): boolean {
  const key = workspaceKey(workspacePath);
  return layout.openTabIds().some((tabId) => {
    if (!isFileTabId(tabId)) return false;
    const owner = workspaceOfPath(tabId);
    return owner !== null && workspaceKey(owner) === key;
  });
}

export const projectsModule = defineModule({
  name: "projects",
  needs: ["layout", "tabs", "url"],
  register: (ctx): ProjectsApi => {
    const layout = ctx.use("layout");
    const tabs = ctx.use("tabs");
    const url = ctx.use("url");

    const show = (workspacePath: string): Promise<void> => {
      const shown = openWorkspace(workspacePath);
      ensureWatching(workspacePath);
      return shown;
    };

    // Opening a project is choosing it: a sidebar on the Everything view
    // (the default when nothing is chosen) moves to the project's files; a
    // sidebar already on a tool stays on it. Written from the live URL,
    // after the open's layout write, so it never writes back a stale one.
    const selectFiles = () => {
      const live = new URLSearchParams(url.search());
      if (readSidebarView(live) !== "everything") return;
      url.setSearch(`?${withSidebarView(live, "files")}`, { replace: true });
    };

    /**
     * Opens in flight, keyed like the open set. Nothing serialises user
     * gestures: a second open of the same project can arrive before the
     * first has finished its disk work, and both would see no open file
     * tab, both would sweep and create — two scratchpads on disk, two tabs
     * in the dock. The whole command (open, sweep, resolve, re-walk, layout
     * write) is the unit made idempotent; a second caller joins the first.
     */
    const inFlight = new Map<string, Promise<void>>();

    const open = (workspacePath: string): Promise<void> => {
      const key = workspaceKey(workspacePath);
      const joined = inFlight.get(key);
      if (joined) return joined;
      const opening = (async () => {
        // Durable before anything else: a reload right after must find it.
        await show(workspacePath);
        // The entry sweep runs either way: abandoned empty scratchpads go
        // (never one open as a tab). Only an EMPTY entry — none of the
        // project's files open in the dock — also lands in the most recent
        // survivor or a fresh one.
        if (hasOpenFileTab(layout, workspacePath)) {
          await sweepScratchpads(workspacePath, layout.openTabIds());
        } else {
          const scratchpad = await enterScratchpad(
            workspacePath,
            layout.openTabIds(),
          );
          if (scratchpad !== null) {
            tabs.open(scratchpad, { intent: "new-tab" });
          }
        }
        selectFiles();
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, opening);
      return opening;
    };

    return { open, show, close: closeWorkspace };
  },
});
