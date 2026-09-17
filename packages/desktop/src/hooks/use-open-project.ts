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
import {
  focusWorkspace,
  isWorkspaceOpen,
  openWorkspace,
  workspaceOfPath,
} from "@/entities/workspaces";
import { enterScratchpad } from "@/entities/scratchpads";
import { ensureWatching } from "@/utils/workspace-watchers";
import { useRecentProjects } from "./use-recent-projects";

/**
 * Bring an already-open workspace to the front. Also the moment a watcher
 * whose start failed (the folder was unreadable when it was opened) gets
 * another chance — the portal's business, so it lives here rather than in
 * the registry.
 */
export function showWorkspace(workspacePath: string): Promise<void> {
  const focused = focusWorkspace(workspacePath);
  ensureWatching(workspacePath);
  return focused;
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

export function useOpenProject(): (workspacePath: string) => Promise<void> {
  const { setLayout } = useLayoutSearchParam();
  const { addRecentProject } = useRecentProjects();

  return useCallback(
    async (workspacePath: string) => {
      addRecentProject(workspacePath);
      // Durable before anything else: a reload right after must find it.
      await Promise.all([
        isWorkspaceOpen(workspacePath)
          ? Promise.resolve()
          : openWorkspace(workspacePath),
        showWorkspace(workspacePath),
      ]);
      // Empty entry: with none of the project's files open, sweep abandoned
      // empty scratchpads (never one open as a tab) and land in the most
      // recent survivor or a fresh one.
      if (hasOpenFileTab(workspacePath)) return;
      const scratchpad = await enterScratchpad(
        workspacePath,
        readOpenTabIds(),
      );
      if (scratchpad === null) return;
      setLayout((layout) =>
        openFileInLayout(layout, { tabId: scratchpad, intent: "new-tab" }),
      );
    },
    [addRecentProject, setLayout],
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
