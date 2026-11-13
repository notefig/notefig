/**
 * Sync mode (MET-266): a workspace kept in step with its git remote.
 * `core.workspace(ws).sync` (`WorkspaceSync`) is the API; `SyncState` is
 * what it shows. The engine loads only for a workspace that syncs.
 */
export * from "./sync";
export * from "./sync-machine";
