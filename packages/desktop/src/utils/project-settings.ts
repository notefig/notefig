/**
 * Per-project settings stored in a `metrists.json` file at the workspace root.
 *
 * The file is the source of truth (tier 1 of the data-layer architecture):
 * it is read through the platform adapter, cached in a TanStack Query entry,
 * and invalidated by the fs watcher when edited externally. It is only
 * created on the first `updateProjectSettings` call — opening a workspace
 * never dirties the user's project.
 */

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { platformAdapter } from "@/adapters";
import { queryClient } from "@/utils/collections";

export const PROJECT_SETTINGS_FILENAME = "metrists.json";

export interface ProjectSettings {
  workspace?: {
    name?: string;
    created?: string;
    version?: string;
  };
  settings?: {
    direction?: "ltr" | "rtl";
    [key: string]: unknown;
  };
}

export function projectSettingsQueryKey(workspacePath: string) {
  return ["project-settings", workspacePath] as const;
}

export function projectSettingsPath(workspacePath: string): string {
  return `${workspacePath}/${PROJECT_SETTINGS_FILENAME}`;
}

/**
 * Read and parse the workspace's metrists.json.
 * A missing file or invalid JSON yields `{}` — never throws.
 */
export async function readProjectSettings(
  workspacePath: string,
): Promise<ProjectSettings> {
  const result = await platformAdapter.readFiles([
    projectSettingsPath(workspacePath),
  ]);
  if (result.succeeded.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(result.succeeded[0].content);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ProjectSettings;
    }
  } catch (error) {
    console.error(
      `[project-settings] Invalid JSON in ${projectSettingsPath(workspacePath)}:`,
      error,
    );
  }
  return {};
}

/**
 * Merge `patch` into the current settings (shallow per top-level section)
 * and write the file back, preserving unknown keys.
 */
export async function updateProjectSettings(
  workspacePath: string,
  patch: Partial<ProjectSettings>,
): Promise<void> {
  const current = await readProjectSettings(workspacePath);
  const next: ProjectSettings = { ...current };
  if (patch.workspace) {
    next.workspace = { ...current.workspace, ...patch.workspace };
  }
  if (patch.settings) {
    next.settings = { ...current.settings, ...patch.settings };
  }

  const result = await platformAdapter.writeFiles([
    {
      path: projectSettingsPath(workspacePath),
      content: JSON.stringify(next, null, 2) + "\n",
    },
  ]);
  if (result.failed.length > 0) {
    throw new Error(
      `Failed to write project settings: ${result.failed.map((f) => f.message).join(", ")}`,
    );
  }

  queryClient.invalidateQueries({
    queryKey: projectSettingsQueryKey(workspacePath),
  });
}

export function useProjectSettings(workspacePath: string) {
  const { data, isLoading } = useQuery({
    queryKey: projectSettingsQueryKey(workspacePath),
    queryFn: () => readProjectSettings(workspacePath),
    staleTime: Infinity,
  });

  const update = useCallback(
    (patch: Partial<ProjectSettings>) =>
      updateProjectSettings(workspacePath, patch),
    [workspacePath],
  );

  return {
    settings: data ?? {},
    isLoading,
    update,
  } as const;
}
