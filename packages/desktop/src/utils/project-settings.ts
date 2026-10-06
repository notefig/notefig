/**
 * Per-project settings stored in a `metrists.json` file at the workspace root.
 *
 * The file is the source of truth (tier 1 of the data-layer architecture):
 * it is read through the platform's fs (`core.projectSettings`), cached in a
 * TanStack Query entry, and invalidated by the fs watcher when edited
 * externally. It is only created on the first `update` call — opening a
 * workspace never dirties the user's project.
 */

import { useCallback } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { defineModule } from "@notefig/core";
import { useModule } from "@notefig/core/react";
import { path as pathutil } from "./path";

export const PROJECT_SETTINGS_FILENAME = "metrists.json";

/** The typed, fully-resolved settings consumers work with. */
export interface ProjectSettingsValues {
  direction: "ltr" | "rtl";
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettingsValues = {
  direction: "ltr",
};

/**
 * Raw on-disk shape of metrists.json. Sections are partial because the file
 * may be absent, hand-edited, or written by other tools; unknown keys are
 * preserved on write but not typed here.
 */
export interface ProjectSettings {
  workspace?: {
    name?: string;
    created?: string;
    version?: string;
  };
  settings?: Partial<ProjectSettingsValues>;
}

/** Overlay the raw file contents onto the defaults. */
export function resolveProjectSettings(
  raw: ProjectSettings,
): ProjectSettingsValues {
  return { ...DEFAULT_PROJECT_SETTINGS, ...raw.settings };
}

export function projectSettingsQueryKey(workspacePath: string) {
  return ["project-settings", workspacePath] as const;
}

export function projectSettingsPath(workspacePath: string): string {
  return pathutil.join(workspacePath, PROJECT_SETTINGS_FILENAME);
}

/** `core.projectSettings`: each workspace's metrists.json. */
export interface ProjectSettingsApi {
  /** Read and parse the file. A missing file or invalid JSON yields `{}` —
   *  never throws. */
  read(workspacePath: string): Promise<ProjectSettings>;
  /** Merge `patch` into the current settings (shallow per top-level
   *  section) and write the file back, preserving unknown keys. */
  update(workspacePath: string, patch: Partial<ProjectSettings>): Promise<void>;
}

export function createProjectSettings({
  fs,
  queryClient,
}: {
  fs: Pick<FileSystemSurface, "readFiles" | "writeFiles">;
  queryClient: QueryClient;
}): ProjectSettingsApi {
  const read = async (workspacePath: string): Promise<ProjectSettings> => {
    const result = await fs.readFiles([projectSettingsPath(workspacePath)]);
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
  };

  return {
    read,
    async update(workspacePath, patch) {
      const current = await read(workspacePath);
      const next: ProjectSettings = { ...current };
      if (patch.workspace) {
        next.workspace = { ...current.workspace, ...patch.workspace };
      }
      if (patch.settings) {
        next.settings = { ...current.settings, ...patch.settings };
      }

      const result = await fs.writeFiles([
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

      await queryClient.invalidateQueries({
        queryKey: projectSettingsQueryKey(workspacePath),
      });
    },
  };
}

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

declare module "@notefig/core" {
  interface CoreModules {
    projectSettings: ProjectSettingsApi;
  }
}

/** Reads and writes go through the platform's fs; an external edit of a
 *  workspace's metrists.json (the watcher reports it) drops the cached
 *  settings, so they are read again. */
export const projectSettingsModule = defineModule({
  name: "projectSettings",
  needs: ["platform", "queryClient"],
  register: (ctx) =>
    createProjectSettings({
      fs: ctx.use("platform").fs,
      queryClient: ctx.use("queryClient"),
    }),
  boot: (_api, ctx) => {
    const queryClient = ctx.use("queryClient");
    return ctx.hooks.on("files:changed", ({ workspacePath, paths }) => {
      if (!paths.includes(projectSettingsPath(workspacePath))) return;
      void queryClient.invalidateQueries({
        queryKey: projectSettingsQueryKey(workspacePath),
      });
    });
  },
});
