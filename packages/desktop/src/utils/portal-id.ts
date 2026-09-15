/**
 * This portal's identity, for the life of the webview.
 *
 * A "portal" is one view onto the workspaces — today the single desktop
 * window or a browser tab; after MET-186, any of N windows; after MET-185,
 * any of N clients attached to the service.
 *
 * It exists because filesystem watch ids were workspace-scoped only
 * (`metadata-${workspacePath}`) while the registry underneath them is
 * process-global: `WATCHERS` in src-tauri/src/file_watcher.rs is a
 * `lazy_static` map keyed by that string, and events are delivered with
 * `app_handle.emit`, which reaches every webview. So two windows open on one
 * workspace did not "each arm their own watcher" — the second window's arm
 * *replaced* the first's entry and dropped its debouncer, and whichever
 * window closed the workspace first removed the shared entry and left the
 * other permanently blind, with `startFailed` false so `ensureWatching`
 * would never re-arm it.
 *
 * Scoping the id per portal makes the registry's key match the thing that
 * actually owns the watch. Nothing parses these ids — they are opaque
 * identity strings compared for equality on both sides — so the component is
 * free to add.
 */

function randomPortalId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Stable for this webview, regenerated on reload — which is correct: a
 * reload drops every watch the previous page armed, and a fresh id avoids
 * inheriting a registry entry whose owner is gone.
 */
export const PORTAL_ID = randomPortalId();
