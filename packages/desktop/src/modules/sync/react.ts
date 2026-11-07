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
import type { WorkspaceSync } from "./sync";
import type { SyncOverwriteRecord } from "./sync-types";

const OFF: SyncCapabilities = syncCapabilities(INITIAL_SYNC_STATE);
const NONE: readonly SyncOverwriteRecord[] = [];

/** Read `read(sync)` live: from the workspace's sync instance while it is
 *  open, through its own changes and the open set's. */
function useSyncValue<T>(
  workspacePath: string | null,
  read: (sync: WorkspaceSync) => T,
  fallback: T,
): T {
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
  return useSyncExternalStore(subscribe, () => {
    const sync = current();
    return sync ? read(sync) : fallback;
  });
}

const readCapabilities = (sync: WorkspaceSync) => sync.capabilities();
const readOverwrites = (sync: WorkspaceSync) => sync.overwrites();

/** The live capabilities of a workspace's sync: `off` while it is not
 *  open or not a sync workspace. */
export function useSyncCapabilities(workspacePath: string | null): SyncCapabilities {
  return useSyncValue(workspacePath, readCapabilities, OFF);
}

/** What merges overwrote in a workspace, live, until dismissed. */
export function useSyncOverwrites(
  workspacePath: string | null,
): readonly SyncOverwriteRecord[] {
  return useSyncValue(workspacePath, readOverwrites, NONE);
}
