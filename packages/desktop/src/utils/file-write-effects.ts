/**
 * Side effects every file write shares, extracted to a leaf module so both
 * sides of the write path — the files entity (in-app writes) and file-sync
 * (watcher/adoption) — can use them without importing each other.
 */
import { queryClient } from "@/entities/query-client";
// Real-git ops are parked; the sidebar panel now derives from the internal
// history repo instead. Restore alongside entities/git's consumers.
// import { invalidateGit } from "@/entities/git";

/**
 * Frontend-side suppression of the app's own write echoes.
 *
 * The platform watchers try to suppress app writes (registerAppWrite in the
 * adapters / APP_WRITES in src-tauri), but their consume-one-registration
 * model has a structural hole under rapid saves: an fs event handler reads
 * the file at handling time, so the event from write N can consume write
 * N+1's registration, and write N+1's own event then comes through as an
 * "external" change. By the time it crosses IPC the editor is further
 * ahead, and adopting it replaces new content with old.
 *
 * So the frontend keeps its own ledger: every content hash this app wrote
 * recently. Matching is a membership test — deliberately NOT consume-once,
 * since several events can legitimately observe the same disk state.
 */
const SELF_WRITE_TTL_MS = 30_000;

const recentSelfWrites = new Map<string, { hash: string; at: number }[]>();

export function recordSelfWrite(path: string, contentHash: string): void {
  const now = Date.now();
  // TTL is the ONLY eviction rule. A fixed-count cap silently drops recent,
  // still-valid hashes under a save burst — and a delayed watcher echo of one
  // of those dropped writes then passes as "external" and overwrites newer
  // content with older (the intermittent "old overwrites new" regression).
  // Pruning by TTL on every write keeps memory bounded to a 30s window, which
  // at the debounced save cadence is a few dozen entries per file.
  const entries = (recentSelfWrites.get(path) ?? []).filter(
    (entry) => now - entry.at < SELF_WRITE_TTL_MS,
  );
  entries.push({ hash: contentHash, at: now });
  recentSelfWrites.set(path, entries);
}

export function isRecentSelfWrite(path: string, contentHash: string): boolean {
  const now = Date.now();
  return (recentSelfWrites.get(path) ?? []).some(
    (entry) => entry.hash === contentHash && now - entry.at < SELF_WRITE_TTL_MS,
  );
}

const INVALIDATE_DEBOUNCE_MS = 500;
const invalidationTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Single invalidation channel for all filesystem-derived query state
 * (search results, git status/checkpoints). Debounced per workspace so
 * bursts of watcher events collapse into one invalidation.
 *
 * Called from file-sync's fs-event handlers and from in-app writes
 * (whose watcher echoes are self-suppressed).
 */
export function invalidateDerivedState(workspaceId: string): void {
  const pending = invalidationTimers.get(workspaceId);
  if (pending) clearTimeout(pending);

  invalidationTimers.set(
    workspaceId,
    setTimeout(() => {
      invalidationTimers.delete(workspaceId);
      queryClient.invalidateQueries({
        queryKey: ["search-content", workspaceId],
      });
      // invalidateGit(workspaceId);
      // Key hand-inlined (matches entities/history.ts's historyQueryKey):
      // importing the entity here would close a files → file-write-effects
      // → history → files import cycle. This module must stay a leaf.
      queryClient.invalidateQueries({
        queryKey: ["history", workspaceId],
      });
    }, INVALIDATE_DEBOUNCE_MS),
  );
}
