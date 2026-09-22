/**
 * Opening a project, from anywhere: the welcome screen, the switcher, the
 * palette, the native menu, error recovery. One hook so every entry point
 * agrees on what "open" means — the workspace joins the open set, comes to
 * the front, and, when none of its files is open in the dock, its
 * scratchpad lands as a tab (MET-135's empty entry). Nothing navigates:
 * the dock is one layout over every open workspace, so opening a project
 * adds to it rather than replacing it.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { readSidebarView, withSidebarView } from "@/hooks/sidebar-view";
import { toast } from "sonner";
import { FsError } from "@/adapters/platform-adapter.interface";
import { pickDirectory } from "@/utils/fs";
import {
  isFileTabId,
  readOpenTabIds,
  useLayoutSearchParam,
} from "@/entities/tabs";
import { workspaceKey } from "@/utils/path";
import { openFileInLayout } from "@/utils/dockable-layout";
import { openWorkspace, workspaceOfPath } from "@/entities/workspaces";
import { enterScratchpad, sweepScratchpads } from "@/entities/scratchpads";
import { ensureWatching } from "@/utils/workspace-watchers";
import { useRecentProjects } from "./use-recent-projects";

/**
 * Open-or-focus plus the portal's half of re-entry: a watcher whose start
 * failed (the folder was unreadable when it was opened) gets another
 * chance. `ensureWatching` is the portal's business, so it lives here
 * rather than in the registry.
 */
export function showWorkspace(workspacePath: string): Promise<void> {
  const shown = openWorkspace(workspacePath);
  ensureWatching(workspacePath);
  return shown;
}

/** Whether any file tab in the dock belongs to the workspace. */
function hasOpenFileTab(workspacePath: string): boolean {
  const key = workspaceKey(workspacePath);
  return readOpenTabIds().some((tabId) => {
    if (!isFileTabId(tabId)) return false;
    const owner = workspaceOfPath(tabId);
    return owner !== null && workspaceKey(owner) === key;
  });
}

/**
 * Opens in flight, keyed like the open set. An open is a user gesture, but
 * nothing serialises gestures: a second call for the same project can
 * arrive before the first has finished its disk work, and both would see
 * no open file tab, both would sweep and create — two scratchpads on disk,
 * two tabs in the dock. The unit made idempotent is the whole command
 * (open, sweep, resolve, re-walk, layout write), so no interleaving of any
 * two steps is possible either; the second caller simply joins the first.
 */
const opensInFlight = new Map<string, Promise<void>>();

export function useOpenProject(): (workspacePath: string) => Promise<void> {
  const { setLayout } = useLayoutSearchParam();
  const [, setUrlSearchParams] = useSearchParams();
  const { addRecentProject } = useRecentProjects();

  return useCallback(
    (workspacePath: string) => {
      const key = workspaceKey(workspacePath);
      const inFlight = opensInFlight.get(key);
      if (inFlight) return inFlight;
      addRecentProject(workspacePath);
      // Opening a project is choosing it: a sidebar on the Everything view
      // (the default when nothing is chosen) moves to the project's files;
      // a sidebar already on a tool stays on it. Written last, from the
      // live URL: the layout write above goes through the router's
      // functional updater, whose snapshot predates this open and would
      // drop the param if it were written first — and reading the render's
      // params here would resurrect a stale layout instead.
      const selectFiles = () => {
        const live = new URLSearchParams(window.location.search);
        if (readSidebarView(live) !== "everything") return;
        setUrlSearchParams(withSidebarView(live, "files"), { replace: true });
      };
      const open = (async () => {
        // Durable before anything else: a reload right after must find it.
        await showWorkspace(workspacePath);
        // The entry sweep runs either way: abandoned empty scratchpads go
        // (never one open as a tab). Only an EMPTY entry — none of the
        // project's files open in the dock — also lands in the most recent
        // survivor or a fresh one; with a file already open there is
        // nothing to land on.
        if (hasOpenFileTab(workspacePath)) {
          await sweepScratchpads(workspacePath, readOpenTabIds());
          selectFiles();
          return;
        }
        const scratchpad = await enterScratchpad(
          workspacePath,
          readOpenTabIds(),
        );
        if (scratchpad !== null) {
          setLayout((layout) =>
            openFileInLayout(layout, { tabId: scratchpad, intent: "new-tab" }),
          );
        }
        selectFiles();
      })().finally(() => {
        opensInFlight.delete(key);
      });
      opensInFlight.set(key, open);
      return open;
    },
    [addRecentProject, setLayout, setUrlSearchParams],
  );
}

/**
 * "Open Folder": the native picker, then `useOpenProject`. A cancelled
 * picker is a null path; a denied one (the browser adapter) is reported,
 * anything else propagates.
 */
export function useOpenProjectFromPicker(): () => Promise<void> {
  const { t } = useTranslation();
  const openProject = useOpenProject();
  return useCallback(async () => {
    try {
      const selectedPath = await pickDirectory(t("pickDirectory"));
      if (selectedPath) await openProject(selectedPath);
    } catch (error) {
      if (error instanceof FsError && error.type === "permission_denied") {
        toast.error(t("pickerPermissionDenied"));
      } else {
        throw error;
      }
    }
  }, [openProject, t]);
}
