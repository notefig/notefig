/**
 * Opening a project from React: remember it as recent, then enter it
 * (`core.workspace(path).open()`, which every other entry point calls
 * directly). What entering does — the scratchpad landing, the sidebar's
 * files view — is the business of the modules that handle
 * `workspace:entered`.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FsError } from "@/adapters/platform-adapter.interface";
import { usePlatform } from "@/core/use-platform";
import i18n from "@/utils/intl";
import { useCore } from "@notefig/core/react";
import { deriveProjectName, useRecentProjects } from "./use-recent-projects";

/**
 * Tell the user a workspace did not open (a module failed to create its
 * part, or recording or landing in it failed). Every gesture that opens or
 * focuses a workspace ends here rather than in an unhandled rejection.
 */
export function reportOpenFailure(workspacePath: string, error: unknown): void {
  console.error(`Failed to open ${workspacePath}:`, error);
  toast.error(
    i18n.t("openProjectFailed", { name: deriveProjectName(workspacePath) }),
  );
}

/**
 * Open a project as the user's gesture. Never rejects: a failure is
 * reported (`reportOpenFailure`), and the promise resolves to whether the
 * workspace opened, for a caller with a next step that needs it.
 */
export function useOpenProject(): (workspacePath: string) => Promise<boolean> {
  const core = useCore();
  const { addRecentProject } = useRecentProjects();
  return useCallback(
    (workspacePath: string) => {
      addRecentProject(workspacePath);
      return core
        .workspace(workspacePath)
        .open()
        .then(
          () => true,
          (error: unknown) => {
            reportOpenFailure(workspacePath, error);
            return false;
          },
        );
    },
    [addRecentProject, core],
  );
}

/**
 * "Open Folder": the native picker, then `useOpenProject`. A cancelled
 * picker is a null path; a denied one (the browser adapter) is reported,
 * anything else propagates.
 */
export function useOpenProjectFromPicker(): () => Promise<void> {
  const { t } = useTranslation();
  const platform = usePlatform();
  const openProject = useOpenProject();
  return useCallback(async () => {
    try {
      const selectedPath = await platform.ui.pickDirectory(t("pickDirectory"));
      if (selectedPath) await openProject(selectedPath);
    } catch (error) {
      if (error instanceof FsError && error.type === "permission_denied") {
        toast.error(t("pickerPermissionDenied"));
      } else {
        throw error;
      }
    }
  }, [platform, openProject, t]);
}
