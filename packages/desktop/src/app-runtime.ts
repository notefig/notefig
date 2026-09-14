/**
 * The boot sequence every composition root must run, in one place.
 *
 * There are two roots for this app — `src/main.tsx` (the Tauri shell) and
 * `packages/marketing/site/main.tsx` (the same app assembled without the
 * desktop-only surfaces) — and MET-185/186/190 add more, one per portal
 * kind. Both steps below are module-scope obligations with no compiler or
 * runtime enforcement behind them: nothing fails at build time if a root
 * forgets, and the symptoms are remote from the cause.
 *
 * That already bit once. The core extraction added `configureCore` and the
 * watcher inversion added `startWorkspaceWatcherSubscription`, both wired
 * into the desktop root only — so on the web build every workspace write
 * threw `CoreNotConfiguredError` from inside `writeWorkspaceTextFile`, and
 * metadata watching (previously armed by the route-level `useFileWatchers`)
 * was silently absent. One function the roots call is the cheapest thing
 * that makes "did this root boot the runtime?" a single greppable question.
 */
import { configureCore } from "@notefig/core";
import { desktopHost } from "@/adapters/desktop-host";
import { startWorkspaceWatcherSubscription } from "@/utils/workspace-watchers";

/**
 * Call once, before render. Safe to call twice — `configureCore` rebinds the
 * same host and the watcher subscription is guarded — but the contract is
 * one call per root.
 *
 * The watcher subscription lives here rather than in a React effect because
 * its lifetime is the process, not a route or a tree: a backgrounded
 * workspace with nothing rendered still has to ingest file events (MET-177).
 * Mounting it in `App` also made it unreachable from the web root, which
 * never renders `App`.
 */
export function bootstrapAppRuntime(): void {
  // Before render: the core is reached from module scope by collections and
  // registries, so a host has to exist before any of them are touched.
  configureCore(desktopHost);
  startWorkspaceWatcherSubscription();
}
