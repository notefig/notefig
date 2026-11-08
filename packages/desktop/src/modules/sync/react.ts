import { useCallback, useSyncExternalStore } from "react";
import { useCore } from "@notefig/core/react";
import { INITIAL_SYNC_STATE, type SyncState } from "./sync-machine";

/** A workspace's live sync state (the initial one while it isn't open).
 *  Follows the open set, so a workspace opened later is picked up. */
export function useSyncState(workspacePath: string | null): SyncState {
  const core = useCore();
  const current = useCallback(() => {
    if (!workspacePath) return null;
    const workspace = core.workspace(workspacePath);
    return workspace.isOpen() ? workspace.sync : null;
  }, [core, workspacePath]);
  const subscribe = useCallback(
    (listener: () => void) => {
      let unsubscribeSync = current()?.subscribe(listener);
      const unsubscribeOpen = core.workspaces.subscribe(() => {
        unsubscribeSync?.();
        unsubscribeSync = current()?.subscribe(listener);
        listener();
      });
      return () => {
        unsubscribeOpen();
        unsubscribeSync?.();
      };
    },
    [core, current],
  );
  return useSyncExternalStore(subscribe, () => current()?.state() ?? INITIAL_SYNC_STATE);
}
