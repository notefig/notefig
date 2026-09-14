/**
 * Metadata-watcher lifetime, driven by the open-workspaces collection
 * (MET-183).
 *
 * Watching is view freshness, and view freshness belongs to whoever is
 * viewing — the portal — not to the workspace registry, which is moving into
 * the host-neutral core and has no business reaching a Rust or browser
 * watcher. So the registry says what is open and this says what is watched,
 * with a subscription in between instead of a direct call.
 *
 * Two behaviors from MET-177 have to survive that inversion, and both are
 * easy to lose:
 *
 *  1. **A backgrounded workspace still watches.** Splitting metadata
 *     watchers from content watchers was done precisely so a workspace that
 *     is open but not rendered — no tabs, nothing mounted — keeps ingesting
 *     file events. This subscription therefore keys off registry
 *     membership, never off what is currently rendered.
 *  2. **A watcher whose start failed re-arms.** A workspace that was
 *     unreadable when first opened gets another chance on re-entry and on
 *     access-restored recovery. Neither of those changes membership, which
 *     is why the row carries `watchEpoch`: the retry arrives as an update
 *     rather than as a call the registry would have had to make.
 */
import {
  openWorkspacesCollection,
  type OpenWorkspaceRow,
} from "@/entities/workspaces";
import {
  startWorkspaceMetadataWatcher,
  type WorkspaceMetadataWatcher,
} from "@/utils/file-sync";

const watchers = new Map<string, WorkspaceMetadataWatcher>();

function arm(row: OpenWorkspaceRow): void {
  if (watchers.has(row.key)) return;
  watchers.set(row.key, startWorkspaceMetadataWatcher(row.path));
}

function disarm(key: string): void {
  watchers.get(key)?.stop();
  watchers.delete(key);
}

/**
 * Begin mirroring the open set into live watchers. Idempotent per process:
 * call it once during boot. Returns the unsubscribe, which also stops every
 * watcher it armed — app teardown and tests both need that.
 */
export function startWorkspaceWatcherSubscription(): () => void {
  // Rows can already exist when this runs (boot order is the host's choice,
  // and a restored session opens workspaces before the portal is ready), so
  // reconcile the current set before listening for changes to it.
  for (const row of openWorkspacesCollection.values()) arm(row);

  const subscription = openWorkspacesCollection.subscribeChanges((changes) => {
    for (const change of changes) {
      const key = String(change.key);
      switch (change.type) {
        case "insert":
          arm(change.value);
          break;
        case "update":
          // The epoch is the retry signal. `ensureStarted` is a no-op on a
          // watcher that is already running, so an unrelated row edit
          // costs nothing — but arm() first, because a workspace whose
          // very first start threw has no watcher to ensure.
          arm(change.value);
          watchers.get(key)?.ensureStarted();
          break;
        case "delete":
          disarm(key);
          break;
      }
    }
  });

  return () => {
    subscription.unsubscribe();
    for (const key of [...watchers.keys()]) disarm(key);
  };
}
