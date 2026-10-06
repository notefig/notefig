/**
 * The open set from React: the registry, its readiness, the focused
 * workspace, and which open workspace holds a path.
 */
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  mostRecentlyFocused,
  workspaceOfPathIn,
  type OpenWorkspaceRow,
  type WorkspaceRegistry,
} from "./workspaces";
import { useCore } from "@notefig/core/react";

/**
 * True once `whenReady` has resolved — gates anything that would treat
 * "not in the open set" as meaningful (stale-tab pruning) so a restored
 * layout is never emptied while its workspaces are still loading.
 */
export function useOpenWorkspacesReady(): boolean {
  const { workspaceRegistry: registry } = useCore();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void registry.whenReady().finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [registry]);
  return ready;
}

function useOpenWorkspaceRows(): OpenWorkspaceRow[] {
  const { collection } = useCore().workspaceRegistry;
  const { data: rows = [] } = useLiveQuery((q) =>
    q.from({ workspace: collection }),
  );
  return rows;
}

export function useFocusedWorkspace(): string | null {
  const rows = useOpenWorkspaceRows();
  return useMemo(() => mostRecentlyFocused(rows)?.path ?? null, [rows]);
}

/** Reactive `workspaceOf`: re-resolves as workspaces open and close. */
export function useWorkspaceOfPath(absolutePath: string): string | null {
  const rows = useOpenWorkspaceRows();
  return useMemo(
    () => workspaceOfPathIn(rows, absolutePath),
    [rows, absolutePath],
  );
}

/** The open set as switcher-ready rows, oldest-opened first. */
export function useOpenWorkspaces(): OpenWorkspaceRow[] {
  const rows = useOpenWorkspaceRows();
  return useMemo(
    () => [...rows].sort((a, b) => a.openedAt - b.openedAt),
    [rows],
  );
}
