/**
 * The file-system surface the core needs, and the error vocabulary that goes
 * with it.
 *
 * This is **derived, not copied**. The desktop's `FileSystemSurface` has 21
 * methods; an inventory of what the orchestration core actually calls — the
 * agent cluster plus the two support surfaces that travel with it,
 * `utils/file-sync.ts` and `utils/history-service.ts` — came back with the
 * seven below. Copying the other fourteen down would be inventing consumers,
 * and several of them (`resolveAssetUrl`, `requestWorkspaceAccess`) have no
 * meaning in a host with no renderer and no permission prompt.
 *
 * Because this is a subset, the existing Tauri and browser adapters satisfy
 * it with no changes at all — they are supersets. The desktop's
 * `platform-adapter.interface.ts` re-exports these types rather than
 * redefining them, so its 39 importers are untouched.
 *
 * The shape is batch-first (`readFiles`, not `readFile`) because the two
 * browser-side implementations pay a real IPC cost per round trip. In Node
 * that is pure ceremony, but one vocabulary across hosts beats a
 * nicer-for-Node second one.
 */

export type FileSystemErrorType =
  | "not_found"
  | "permission_denied"
  | "handle_missing"
  | "already_exists"
  | "invalid_path"
  | "not_empty"
  | "is_directory"
  | "is_file"
  | "io_error"
  | "unknown";

export type FileSystemError = {
  path: string;
  type: FileSystemErrorType;
  message: string;
};

/**
 * Throwable form of FileSystemError — one class shared across platforms,
 * discriminated by the same FileSystemErrorType. Satisfies the
 * FileSystemError shape so it can be returned in Result/BatchResult as-is.
 *
 * Lives here rather than in any one host so that every implementation throws
 * the same class into the same boundary. `HostFsError`, briefly introduced by
 * the headless CLI host, was a duplicate of this idea and is gone.
 */
export class FsError extends Error implements FileSystemError {
  constructor(
    readonly type: FileSystemErrorType,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${type.replace(/_/g, " ")}: ${path}`);
    this.name = "FsError";
  }
}

/**
 * True when the error means the host lost access to the workspace folder and
 * the user can recover it (re-grant on web, OS settings on desktop, re-pick).
 */
export function isWorkspaceAccessError(error: unknown): error is FsError {
  return (
    error instanceof FsError &&
    (error.type === "permission_denied" || error.type === "handle_missing")
  );
}

export type Result<T, E = FileSystemError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type BatchResult<T> = {
  succeeded: T[];
  failed: FileSystemError[];
};

export type FileSystemMetadata = {
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: Date;
  createdAt: Date;
};

export type MetadataChange = {
  type: "created" | "deleted" | "renamed";
  path: string;
  oldPath?: string; // populated only for rename events
  isDirectory: boolean;
};

export type MetadataChangeEvent = {
  /** The watch that produced this event — consumers route by it, so one
   *  workspace's events never reach another's handlers (MET-177). */
  watchId: string;
  changes: MetadataChange[];
};

export type ContentChange = {
  path: string;
  content: string;
  contentHash: string;
};

export type ContentChangeEvent = {
  /** See MetadataChangeEvent.watchId. */
  watchId: string;
  changes: ContentChange[];
};

/**
 * Watcher events, delivered on the fs surface rather than the general
 * platform bus so that surface is self-contained. The `fs-` prefixed names
 * are kept deliberately: they are the same strings the Rust watcher emits
 * (`file_watcher.rs`), so the wire name stays greppable from the consumer.
 */
export type FsChangeEvent =
  | { type: "fs-metadata-changed"; payload: MetadataChangeEvent }
  | { type: "fs-content-changed"; payload: ContentChangeEvent };

export type FsChangeListener = (event: FsChangeEvent) => void;

export interface CoreFileSystem {
  /** Read file contents. */
  readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>>;

  /** Write/update files, creating parent directories as needed. */
  writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>>;

  /** File/directory metadata. */
  getMetadata(paths: string[]): Promise<BatchResult<FileSystemMetadata>>;

  /** Existence check. Never fails; reports `exists: false` for errors. */
  exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]>;

  // Deliberately no watcher members. They were here in the first draft and
  // failed the inventory this surface claims to come from: no module in
  // `packages/core` calls them, the desktop's callers are portal-side by
  // design (`useContentWatchers` is a React hook, `workspace-watchers.ts`
  // names itself the portal), and the headless host cannot implement them at
  // all — it had to throw, which is a third degradation style the host
  // contract explicitly rules out. The asymmetry gave it away: the surface
  // declared `startWatchingContent` but not the `startWatchingMetadata` that
  // file-sync actually calls, so `stopWatching` stopped watches it could not
  // start. Watching reaches the platform through the desktop's full
  // `FileSystemSurface`, which is a superset of this one.
}
