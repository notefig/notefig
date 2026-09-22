/**
 * The boot sequence every composition root must run, in one place.
 *
 * There are two roots for this app — `src/main.tsx` (the Tauri shell) and
 * `packages/marketing/site/main.tsx` (the same app assembled without the
 * desktop-only surfaces) — and the portal work adds more, one per portal
 * kind. What goes here is a module-scope obligation with no compiler or
 * runtime enforcement behind it: nothing fails at build time if a root
 * forgets, and the symptoms are remote from the cause (a workspace that
 * silently stops seeing file changes). One function the roots call is the
 * cheapest thing that makes "did this root boot the runtime?" a single
 * greppable question.
 */
import { startTreeInlineEditDismissal } from "@/components/editor/file-tree";
import { startPromptRoundTracking } from "@/entities/prompt-rounds";
import { startUnseenTracking } from "@/entities/unseen";
import { startWorkspaceWatcherSubscription } from "@/utils/workspace-watchers";
import { restoreOpenWorkspaces } from "@/entities/workspaces";

export interface BootstrapAppRuntimeOptions {
  /**
   * Reopen the workspaces the user left open (persisted open set). The
   * desktop shell wants this — it is a command center over all of them —
   * while the marketing site always seeds its one fixed root itself.
   */
  restoreWorkspaces?: boolean;
}

/**
 * Call once, before render. Safe to call twice — the watcher subscription is
 * guarded and the restore is idempotent — but the contract is one call per
 * root.
 *
 * The subscription lives here rather than in a React effect because its
 * lifetime is the process, not a route or a tree: a backgrounded workspace
 * with nothing rendered still has to ingest file events (MET-177). Mounting
 * it in `App` would also make it unreachable from the web root, which never
 * renders `App`. The restore runs after the subscription is live, so the
 * rows it hydrates arm their watchers as they arrive.
 */
export function bootstrapAppRuntime({
  restoreWorkspaces = true,
}: BootstrapAppRuntimeOptions = {}): void {
  startWorkspaceWatcherSubscription();
  startUnseenTracking();
  startPromptRoundTracking();
  startTreeInlineEditDismissal();
  if (restoreWorkspaces) {
    void restoreOpenWorkspaces().catch((error) => {
      console.error("Failed to restore open workspaces:", error);
    });
  }
}
