/**
 * Side effects every file write shares, extracted to a leaf module so both
 * sides of the write path — the files entity (in-app writes) and file-sync
 * (watcher/adoption) — can use them without importing each other.
 */
import { queryClient } from "@/entities/query-client";
// Only referenced inside a function body below, never at module-eval time.
import { invalidateGit } from "@/entities/git";

// Deliberately no self-write-echo ledger here anymore: echoes are settled
// by state truth instead — a fresh disk read in handleContentFileSystemChange
// and the row-currency check in useEditorFileSync (see the rationale there).
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
      invalidateGit(workspaceId);
    }, INVALIDATE_DEBOUNCE_MS),
  );
}
