/**
 * The app state a debug report describes, read as of this render: the
 * focused workspace, the dock layout from the URL, and the git status the
 * query cache holds for the workspace. The debug panel and the feedback
 * dialog both build their report from it (`utils/debug-report.ts`).
 *
 * Self-sufficient for the debug panel's crash fallback: its only runtime
 * dependencies are the QueryClient and pure leaves.
 */
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusedWorkspace } from "@/modules/workspaces/react";
// Type-only — erased at runtime.
import type { GitRow } from "@/modules/git";
import {
  LAYOUT_PARAM,
  extractTabIds,
  findLayoutSelectedTab,
  parseLayout,
} from "@/utils/layout-codec";
import { path as pathutil } from "@/utils/path";
import type { DebugSnapshot } from "@/utils/debug-report";

export function useDebugSnapshot(searchParams: URLSearchParams): DebugSnapshot {
  // The focused workspace stands in for the old route param: the dock
  // spans every open workspace, so this is only the sidebar's scope.
  const basePath = useFocusedWorkspace() ?? undefined;

  const dockableLayout = useMemo(
    () => parseLayout(searchParams.get(LAYOUT_PARAM)),
    [searchParams],
  );
  const openTabs = useMemo(() => extractTabIds(dockableLayout), [dockableLayout]);
  const activeTabId = useMemo(() => findLayoutSelectedTab(dockableLayout), [dockableLayout]);

  const queryClient = useQueryClient();
  // Key hand-inlined on purpose (self-sufficiency): matches modules/git/git.ts's
  // gitQueryKey — the git collection stores its GitRow[] in the query cache.
  // Normalized, because gitQueryKey normalizes; a respelled basePath would
  // otherwise read an empty cache and the report would show no git state.
  const gitStatusQueryKey = basePath ? (["git", pathutil.normalize(basePath)] as const) : null;
  const rows = gitStatusQueryKey
    ? (queryClient.getQueryData<GitRow[]>(gitStatusQueryKey) ?? null)
    : null;
  const repoRow =
    rows?.find((row): row is GitRow & { kind: "repo" } => row.kind === "repo") ?? null;
  const queryState = gitStatusQueryKey ? queryClient.getQueryState(gitStatusQueryKey) : undefined;

  return {
    basePath,
    searchParams,
    dockableLayout,
    openTabs,
    activeTabId,
    git: {
      rows,
      error: gitStatusQueryKey
        ? ((queryState?.error as Error | null) ?? repoRow?.statusError ?? null)
        : null,
      updatedAt: queryState?.dataUpdatedAt ?? 0,
    },
  };
}
