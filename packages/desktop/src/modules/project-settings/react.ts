/**
 * A workspace's project settings from React.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModule } from "@notefig/core/react";
import {
  projectSettingsQueryKey,
  resolveProjectSettings,
  type ProjectSettings,
} from "./project-settings";

export function useProjectSettings(workspacePath: string) {
  const projectSettings = useModule("projectSettings");
  const { data, isLoading } = useQuery({
    queryKey: projectSettingsQueryKey(workspacePath),
    queryFn: () => projectSettings.read(workspacePath),
    staleTime: Infinity,
  });

  const update = useCallback(
    (patch: Partial<ProjectSettings>) =>
      projectSettings.update(workspacePath, patch),
    [projectSettings, workspacePath],
  );

  return {
    settings: resolveProjectSettings(data ?? {}),
    isLoading,
    update,
  } as const;
}
