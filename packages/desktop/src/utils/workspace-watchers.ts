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
 *     access-restored recovery. Neither changes membership, so neither
 *     reaches the subscription — they arrive as `ensureWatching` calls from
 *     the two portal-side places that already know those moments happened
 *     (the route loader and the error boundary). That keeps the registry
 *     publishing pure membership, which is the thing core is going to own.
 */
import {
  openWorkspacesCollection,
  type OpenWorkspaceRow,
} from "@/entities/workspaces";
import {
  startWorkspaceMetadataWatcher,
  type WorkspaceMetadataWatcher,
} from "@/utils/file-sync";
import { workspaceKey } from "@/utils/path";

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
 * Give a workspace's watcher another chance to arm.
 *
 * A watcher whose OS-level start failed (the workspace was unreadable when
 * it was opened) parks itself; `ensureStarted` is a no-op on a healthy one.
 * The two moments worth retrying — re-entering a backgrounded workspace,
 * and recovering after fs access is restored — both originate in the
 * portal, so they call this directly rather than round-tripping a signal
 * through the registry.
 */
export function ensureWatching(workspacePath: string): void {
  watchers.get(workspaceKey(workspacePath))?.ensureStarted();
}

/** Non-null while a subscription is live. `watchers` is module scope, so a
 *  second concurrent subscription would share it: the second call's disposer
 *  would stop the watchers the first armed and leave the first subscribed to
 *  an empty map. The guard is what makes the idempotence below real rather
 *  than asserted. */
let activeSubscription: (() => void) | null = null;

/**
 * Begin mirroring the open set into live watchers. Idempotent per process:
 * call it once during boot — a second call while one is live is a no-op that
 * returns the same disposer. Returns the unsubscribe, which also stops every
 * watcher it armed — app teardown and tests both need that.
 */
export function startWorkspaceWatcherSubscription(): () => void {
  if (activeSubscription) return activeSubscription;

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
          // Membership is unchanged, so there is nothing to arm or stop —
          // but a row can be re-inserted under the same key by a
          // close/reopen race, and arm() is idempotent.
          arm(change.value);
          break;
        case "delete":
          disarm(key);
          break;
      }
    }
  });

  const dispose = () => {
    if (activeSubscription !== dispose) return;
    activeSubscription = null;
    subscription.unsubscribe();
    for (const key of [...watchers.keys()]) disarm(key);
  };
  activeSubscription = dispose;
  return dispose;
}
