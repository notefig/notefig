import { useMemo } from "react";
import { createCollection } from "@tanstack/react-db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { platformAdapter } from "@/adapters";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { queryClient } from "@/utils/collections";
import * as sharedConfig from "@shared/config";

type ProjectConfigV1Output = import("@shared/config").ProjectConfigV1Output;

export const DEFAULT_PROJECT_CONFIG =
  sharedConfig.createDefaultProjectConfigV1();
const NO_WORKSPACE_ID = "__NO_WORKSPACE__";

export interface ProjectConfigRow {
  id: "project";
  status: "missing" | "ok" | "error";
  config: ProjectConfigV1Output | null;
  error: string | null;
}

const projectConfigCollectionRegistry = new Map<
  string,
  ReturnType<typeof createProjectConfigCollection>
>();

function getProjectConfigPath(workspaceId: string): string {
  return `${workspaceId}/${sharedConfig.PROJECT_CONFIG_FILE_NAME}`.replace(
    /\/+/g,
    "/",
  );
}

function toProjectConfigRow(
  status: ProjectConfigRow["status"],
  config: ProjectConfigV1Output | null,
  error: string | null,
): ProjectConfigRow {
  return {
    id: "project",
    status,
    config,
    error,
  };
}

function getProcessEnv(): Record<string, string | undefined> {
  if (
    typeof process !== "undefined" &&
    process &&
    typeof process === "object" &&
    "env" in process
  ) {
    return (process as { env: Record<string, string | undefined> }).env;
  }

  return {};
}

function createProjectConfigCollection(workspaceId: string) {
  const hasWorkspace = workspaceId !== NO_WORKSPACE_ID;
  const configPath = getProjectConfigPath(workspaceId);

  return createCollection(
    queryCollectionOptions<ProjectConfigRow, string>({
      queryKey: ["project-config", workspaceId],
      queryClient,

      queryFn: async (): Promise<ProjectConfigRow[]> => {
        if (!hasWorkspace) {
          return [toProjectConfigRow("missing", null, null)];
        }

        const fileRead = await platformAdapter.readFiles([configPath]);
        const read = fileRead.succeeded[0];

        if (!read) {
          return [toProjectConfigRow("missing", null, null)];
        }

        try {
          const config = sharedConfig.parseProjectConfigWithEnv(
            read.content,
            getProcessEnv(),
          );
          return [toProjectConfigRow("ok", config, null)];
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown config error";
          return [toProjectConfigRow("error", null, message)];
        }
      },

      getKey: (item) => item.id,

      onInsert: async ({ transaction }) => {
        const mutation = transaction.mutations[0];
        if (!mutation) return;

        const nextConfig =
          mutation.modified.config ??
          sharedConfig.createDefaultProjectConfigV1();
        const writeResult = await platformAdapter.writeFiles([
          {
            path: configPath,
            content: JSON.stringify(nextConfig, null, 2) + "\n",
          },
        ]);

        if (writeResult.failed.length > 0) {
          throw new Error(writeResult.failed[0].message);
        }
      },

      onUpdate: async ({ transaction }) => {
        const mutation = transaction.mutations[0];
        if (!mutation) return;

        const nextConfig = mutation.modified.config;
        if (!nextConfig) return;

        const writeResult = await platformAdapter.writeFiles([
          {
            path: configPath,
            content: JSON.stringify(nextConfig, null, 2) + "\n",
          },
        ]);

        if (writeResult.failed.length > 0) {
          throw new Error(writeResult.failed[0].message);
        }
      },
    }),
  );
}

export function getOrCreateProjectConfigCollection(workspaceId: string) {
  const existing = projectConfigCollectionRegistry.get(workspaceId);
  if (existing) {
    return existing;
  }

  const collection = createProjectConfigCollection(workspaceId);
  projectConfigCollectionRegistry.set(workspaceId, collection);
  return collection;
}

export async function refreshProjectConfig(workspaceId: string): Promise<void> {
  const collection = getOrCreateProjectConfigCollection(workspaceId);
  await collection.utils.refetch();
}

export function writeProjectConfig(
  workspaceId: string,
  nextConfig: unknown,
): void {
  const validatedConfig = sharedConfig.parseProjectConfigObject(nextConfig);
  const collection = getOrCreateProjectConfigCollection(workspaceId);
  const existing = collection.get("project");

  if (existing) {
    collection.update("project", (draft) => {
      draft.status = "ok";
      draft.config = validatedConfig;
      draft.error = null;
    });
    return;
  }

  collection.insert({
    id: "project",
    status: "ok",
    config: validatedConfig,
    error: null,
  });
}

export function updateProjectConfig(
  workspaceId: string,
  updater: (current: ProjectConfigV1Output) => unknown,
): void {
  const collection = getOrCreateProjectConfigCollection(workspaceId);
  const existing = collection.get("project");
  const baseConfig =
    existing?.status === "ok" && existing.config
      ? existing.config
      : DEFAULT_PROJECT_CONFIG;

  const nextConfig = updater(baseConfig);
  writeProjectConfig(workspaceId, nextConfig);
}

export function useProjectConfig<TSelected>(
  workspacePath: string,
  selector: (config: ProjectConfigV1Output) => TSelected | null | undefined,
  fallback?: TSelected,
): TSelected {
  const collection = getOrCreateProjectConfigCollection(workspacePath);

  const { data: rows = [] } = useLiveQuery(
    (q) =>
      q.from({ project: collection }).select(({ project }) => ({
        status: project.status,
        config: project.config,
      })),
    [workspacePath],
  );

  const config = useMemo(() => {
    const row = rows[0] as
      | {
          status: ProjectConfigRow["status"];
          config: ProjectConfigV1Output | null;
        }
      | undefined;

    return row?.status === "ok" && row.config
      ? row.config
      : DEFAULT_PROJECT_CONFIG;
  }, [rows]);

  const selected = selector(config);
  if (selected !== null && selected !== undefined) {
    return selected;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  return selector(DEFAULT_PROJECT_CONFIG) as TSelected;
}

export function useConfig<TSelected>(
  selector: (config: ProjectConfigV1Output) => TSelected | null | undefined,
  fallback?: TSelected,
): TSelected {
  const { workspacePath } = useWorkspaceParams();

  return useProjectConfig(workspacePath ?? NO_WORKSPACE_ID, selector, fallback);
}

export function useUpdateConfig(): (
  updater: (current: ProjectConfigV1Output) => unknown,
) => void {
  const { workspacePath } = useWorkspaceParams();
  const mutation = useMutation({
    mutationFn: async (
      updater: (current: ProjectConfigV1Output) => unknown,
    ) => {
      updateProjectConfig(workspacePath ?? NO_WORKSPACE_ID, updater);
    },
  });

  return (updater: (current: ProjectConfigV1Output) => unknown) => {
    mutation.mutate(updater);
  };
}
