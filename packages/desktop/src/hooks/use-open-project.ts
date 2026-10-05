/**
 * Opening a project from React: remember it as recent, then
 * `core.projects.open` — which every other entry point calls directly.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FsError } from "@/adapters/platform-adapter.interface";
import { pickDirectory } from "@/utils/fs";
import { useCore } from "@notefig/core/react";
import { useRecentProjects } from "./use-recent-projects";

export function useOpenProject(): (workspacePath: string) => Promise<void> {
  const { projects } = useCore();
  const { addRecentProject } = useRecentProjects();
  return useCallback(
    (workspacePath: string) => {
      addRecentProject(workspacePath);
      return projects.open(workspacePath);
    },
    [addRecentProject, projects],
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
