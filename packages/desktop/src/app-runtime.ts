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
import { startWorkspaceWatcherSubscription } from "@/utils/workspace-watchers";

/**
 * Call once, before render. Safe to call twice — the watcher subscription is
 * guarded — but the contract is one call per root.
 *
 * The subscription lives here rather than in a React effect because its
 * lifetime is the process, not a route or a tree: a backgrounded workspace
 * with nothing rendered still has to ingest file events (MET-177). Mounting
 * it in `App` would also make it unreachable from the web root, which never
 * renders `App`.
 */
export function bootstrapAppRuntime(): void {
  startWorkspaceWatcherSubscription();
}
