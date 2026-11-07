/**
 * A workspace's sync state from React.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useCore } from "@notefig/core/react";
import {
  INITIAL_SYNC_STATE,
  syncCapabilities,
  type SyncCapabilities,
} from "./sync-machine";

const OFF: SyncCapabilities = syncCapabilities(INITIAL_SYNC_STATE);

/** The live capabilities of a workspace's sync: `off` while it is not
 *  open or not a sync workspace. Joins the open set with the instance's
 *  own changes. */
export function useSyncCapabilities(
  workspacePath: string | null,
): SyncCapabilities {
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
  return useSyncExternalStore(
    subscribe,
    () => current()?.capabilities() ?? OFF,
  );
}
