/**
 * A workspace's project settings from React.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  projectSettingsQueryKey,
  resolveProjectSettings,
  type ProjectSettings,
} from "./project-settings";
import { useCore } from "@notefig/core/react";

export function useProjectSettings(workspacePath: string) {
  const { projectSettings } = useCore();
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
