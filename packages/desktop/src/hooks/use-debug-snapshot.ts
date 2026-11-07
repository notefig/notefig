/**
 * The app's state a debug report describes, live: the route and the dock's
 * tabs and layout. Read by the debug panel (which shows and copies it) and
 * the feedback dialog (which can attach it).
 *
 * As self-sufficient as the panel it came from, which the crash fallback
 * renders: its runtime dependencies are the router and the open-workspace
 * rows.
 */
import { useMemo } from "react";
import { useSearch } from "@/modules/layout/react";
import { useFocusedWorkspace } from "@/modules/workspaces/react";
// Pure zero-dependency leaf — safe for the crash fallback (unlike entity
// modules, which must never be runtime imports here).
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
import type { DebugSnapshot } from "@/utils/debug-report";

export function useDebugSnapshot(): DebugSnapshot {
  const search = useSearch();
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
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

  return {
    basePath,
    searchParams,
    dockableLayout,
    openTabs,
    activeTabId,
  };
}
