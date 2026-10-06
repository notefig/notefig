/**
 * Reading a workspace's git rows from React.
 */
import { useMemo } from "react";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import { useIsFetching } from "@tanstack/react-query";
import {
  gitQueryKey,
  type GitCheckpointRow,
  type GitCollection,
  type GitRepoRow,
  type GitRow,
  type GitSummary,
} from "./git";

/** The workspace's git collection, while the workspace is open. */
function useGitCollection(
  workspacePath: string | undefined,
): GitCollection | undefined {
  return useWorkspaceModule(workspacePath, "git")?.collection;
}

/** The repo summary row + change flag; undefined until the first fetch lands. */
export function useGitSummary(
  workspacePath: string | undefined,
): GitSummary | undefined {
  const collection = useGitCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) => (collection ? q.from({ git: collection }) : undefined),
    [collection],
  );
  return useMemo(() => {
    const repo = (data as GitRow[]).find(
      (row): row is GitRepoRow => row.kind === "repo",
    );
    if (!repo) return undefined;
    return {
      initialized: repo.initialized,
      branch: repo.branch,
      ahead: repo.ahead,
      behind: repo.behind,
      statusError: repo.statusError,
      logError: repo.logError,
      hasChanges: (data as GitRow[]).some((row) => row.kind === "file"),
    };
  }, [data]);
}

/** Checkpoints newest-first. */
export function useGitCheckpoints(workspacePath: string): GitCheckpointRow[] {
  const collection = useGitCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      collection
        ? q
            .from({ git: collection })
            .where(({ git }) => eq(git.kind, "checkpoint"))
        : undefined,
    [collection],
  );
  return useMemo(
    () =>
      (data as GitCheckpointRow[])
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp),
    [data],
  );
}

/** Whether the workspace's git fetch is in flight (anti-flicker gates). */
export function useGitFetching(workspacePath: string): boolean {
  const { queryClient } = useCore();
  return (
    useIsFetching({ queryKey: gitQueryKey(workspacePath) }, queryClient) > 0
  );
}
