/**
 * The app's state a debug report describes, live: the route, the dock's
 * tabs and layout, and the focused workspace's git status cache. Read by
 * the debug panel (which shows and copies it) and the feedback dialog
 * (which can attach it).
 *
 * As self-sufficient as the panel it came from, which the crash fallback
 * renders: its runtime dependencies are the router, the query client and
 * the open-workspace rows.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusedWorkspace } from "@/modules/workspaces/react";
import { path as pathutil } from "@/utils/path";
// Pure zero-dependency leaf — safe for the crash fallback (unlike entity
// modules, which must never be runtime imports here).
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
// Type-only import — erased at runtime, so the crash panel stays
// self-sufficient (its only runtime dependency is the QueryClient).
import type { GitRow } from "@/modules/git";
import type { DebugSnapshot } from "@/utils/debug-report";
import type { QueryClient } from "@tanstack/react-query";

export function useDebugSnapshot(): DebugSnapshot {
  const [searchParams] = useSearchParams();
  // The focused workspace stands in for the old route param: the dock
  // spans every open workspace, so this is only the sidebar's scope.
  const workspacePath = useFocusedWorkspace();
  const basePath = workspacePath ?? undefined;

  const dockableLayout = useMemo(
    () => parseLayout(searchParams.get(LAYOUT_PARAM)),
    [searchParams],
  );
  const openTabs = useMemo(
    () => extractTabIds(dockableLayout),
    [dockableLayout],
  );
  const activeTabId = useMemo(
    () => findLayoutSelectedTab(dockableLayout),
    [dockableLayout],
  );
  useQueryCacheTick();
  const git = gitStatusCache(useQueryClient(), basePath);

  return {
    basePath,
    searchParams,
    dockableLayout,
    openTabs,
    activeTabId,
    git,
  };
}

/** The focused workspace's git collection, as the query cache holds it. */
function gitStatusCache(
  queryClient: QueryClient,
  basePath: string | undefined,
): DebugSnapshot["git"] {
  if (!basePath) return { rows: null, error: null, updatedAt: 0 };
  // Key hand-inlined on purpose (self-sufficiency): matches modules/git/git.ts's
  // gitQueryKey — the git collection stores its GitRow[] in the query cache.
  // Normalized, because gitQueryKey normalizes; a respelled basePath would
  // otherwise read an empty cache and the panel would show no git state.
  const key = ["git", pathutil.normalize(basePath)] as const;
  const rows = queryClient.getQueryData<GitRow[]>(key) ?? null;
  const repoRow = rows?.find(
    (row): row is GitRow & { kind: "repo" } => row.kind === "repo",
  );
  const state = queryClient.getQueryState(key);
  return {
    rows,
    error: (state?.error as Error | null) ?? repoRow?.statusError ?? null,
    updatedAt: state?.dataUpdatedAt ?? 0,
  };
}

function useQueryCacheTick(): number {
  const queryClient = useQueryClient();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Cache events fire synchronously — including from inside another
    // component's render when its mount starts a query (the git collection
    // is lazy since the status bar stopped subscribing to it, so opening
    // the checkpoint panel does exactly that). Defer the tick out of that
    // render stack; the flag coalesces event bursts into one re-render.
    let scheduled = false;
    let disposed = false;
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) setTick((prev) => prev + 1);
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [queryClient]);

  return tick;
}
