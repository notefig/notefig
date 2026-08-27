import type { Theme } from "@/components/theme-provider";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import type { HarnessDefinition } from "@notefig/shared/agent";
import type {
  AgentTransport,
  McpEndpoint,
} from "@notefig/agent";

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
 * True when the error means the app lost access to the workspace folder and
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

export type TextPromptOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
};

export type MetadataChange = {
  type: "created" | "deleted" | "renamed";
  path: string;
  oldPath?: string; // populated only for rename events
  isDirectory: boolean;
};

export type MetadataChangeEvent = {
  changes: MetadataChange[];
};

export type ContentChange = {
  path: string;
  content: string;
  contentHash: string;
};

export type ContentChangeEvent = {
  changes: ContentChange[];
};

/**
 * App-side ignore rules for listing/search/watch operations. Opt-in per
 * call: callers that must see the complete tree (notably the git storage
 * host) simply never pass them. Lists come from utils/ignore.ts and are
 * lowercased there.
 */
export type IgnoreRulesOption = {
  directories: string[];
  extensions: string[];
};

export type SearchOptions = {
  query: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  /** File pattern filter (e.g., "*.md", "*.txt") */
  filePattern?: string;
  /** Limit search to these file paths only. If omitted, adapter discovers files itself. */
  fileIncludes?: string[];
  /** Maximum number of results (default: 1000) */
  maxResults?: number;
  /** Skip ignored directories/extensions while discovering files. */
  ignore?: IgnoreRulesOption;
};

/**
 * What a search match reliably knows about itself, independent of raw
 * file coordinates. Line/columns deliberately don't cross this surface:
 * the editor renders a parsed document that doesn't contain the file's
 * bytes, so raw coordinates can never be mapped exactly — these three
 * facts can (see editor-position.ts).
 */
export type SearchTarget = {
  /** The exact matched text */
  matchText: string;
  /** Raw content of the line containing the match */
  lineText: string;
  /** 0-indexed occurrence among matches with the same text in this file */
  occurrence: number;
};

export type SearchMatch = SearchTarget & {
  /** Absolute path to the file */
  filePath: string;
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

/** Window/OS-level events. Watcher events live on the fs surface instead. */
export type PlatformEvent =
  | { type: "theme-changed"; payload: Theme }
  | { type: "folder-selected"; payload: string }
  | { type: "file-dropped"; payload: string[] }
  | { type: "zoom-changed"; payload: number };

export type PlatformEventListener = (event: PlatformEvent) => void;

export type UpdateFlow = "download-restart" | "refresh";

export type UpdateCheckResult =
  | {
      status: "available";
      flow: UpdateFlow;
      version: string;
      body?: string;
    }
  | {
      status: "up-to-date";
      flow: UpdateFlow;
    }
  | {
      status: "error";
      error: string;
    };

export type UpdateApplyProgress =
  | {
      status: "downloading";
      downloaded: number;
      total: number | null;
    }
  | {
      status: "ready";
    }
  | {
      status: "applied";
    }
  | {
      status: "error";
      error: string;
    };

export type UpdateRestartResult =
  | {
      status: "restarted";
    }
  | {
      status: "error";
      error: string;
    };

export interface PlatformUpdater {
  check(): Promise<UpdateCheckResult>;
  apply(): AsyncGenerator<UpdateApplyProgress, void, void>;
  restart(): Promise<UpdateRestartResult>;
}

/**
 * File system surface: files, directories, metadata, watching, search, and
 * the two properties of the fs backend that callers must be able to reach
 * alongside it (asset URL resolution and permission re-acquisition — the FS
 * Access API needs both).
 */
export interface FileSystemSurface {
  /**
   * (Re)acquire access to a workspace folder after a permission failure.
   * On web this MUST run inside a user gesture (it calls
   * handle.requestPermission); elsewhere it's a no-op returning true.
   */
  requestWorkspaceAccess(workspacePath: string): Promise<boolean>;

  /**
   * Read directory contents
   * @returns Result with array of absolute paths
   */
  readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
      includeHidden?: boolean;
      /** Opt-in ignore filtering; omitted ⇒ complete listing (git host path). */
      ignore?: IgnoreRulesOption;
    },
  ): Promise<Result<string[]>>;

  /**
   * Create directories (creates parent directories if needed)
   * @returns Batch result with succeeded paths and failed operations
   */
  createDirectories(paths: string[]): Promise<BatchResult<string>>;

  /**
   * Delete directories
   * @param options.recursive - If true, delete non-empty directories
   * @returns Batch result with succeeded paths and failed operations
   */
  deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>>;

  /**
   * Move/rename a directory
   * @returns Result indicating success or failure
   */
  moveDirectory(oldPath: string, newPath: string): Promise<Result<void>>;

  /**
   * Read file contents
   * @returns Batch result with file data for succeeded reads and errors for failures
   */
  readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>>;

  /**
   * Read binary file contents
   * @returns Batch result with binary data for succeeded reads and errors for failures
   */
  readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>>;

  /**
   * Write/update files (creates or updates)
   * Creates parent directories if they don't exist
   * @returns Batch result with succeeded paths and failed operations
   */
  writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>>;

  /**
   * Create empty files
   * Creates parent directories if they don't exist
   * @returns Batch result with succeeded paths and failed operations
   */
  createFiles(paths: string[]): Promise<BatchResult<string>>;

  /**
   * Delete files
   * @returns Batch result with succeeded paths and failed operations
   */
  deleteFiles(paths: string[]): Promise<BatchResult<string>>;

  /**
   * Move/rename a file
   * @returns Result indicating success or failure
   */
  moveFile(oldPath: string, newPath: string): Promise<Result<void>>;

  /**
   * Copy a file
   * @returns Result indicating success or failure
   */
  copyFile(from: string, to: string): Promise<Result<void>>;

  /**
   * Write binary files (images, videos, audio, etc.)
   * Creates parent directories if they don't exist
   * @param files - Array of objects containing path and binary data
   * @returns Batch result with succeeded paths and failed operations
   */
  writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>>;

  /**
   * Resolve a relative asset path to a displayable URL
   * In Tauri: converts to asset:// protocol
   * In Browser: creates blob URL from IndexedDB
   * @param relativePath - Relative path from workspace root
   * @param workspacePath - Absolute path to the workspace directory
   * @returns Resolved URL for display (absolute URL or blob URL)
   */
  resolveAssetUrl(relativePath: string, workspacePath: string): Promise<string>;

  /**
   * Check if paths exist
   * @returns Array of existence results (never fails, returns exists: false for errors)
   */
  exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]>;

  /**
   * Get file/directory metadata
   * @returns Batch result with metadata for succeeded operations
   */
  getMetadata(paths: string[]): Promise<BatchResult<FileSystemMetadata>>;

  /**
   * Start watching directories for metadata changes (creates, deletes, renames)
   * Watches recursively - will detect all changes within the directory tree
   * @param paths - Directory paths to watch
   * @param watchId - Unique identifier for this watch session
   * @param options.ignore - Drop events for ignored directories/extensions
   * @param options.allowHiddenSubtrees - Subtrees whose events pass the
   *   hidden-path filter (MET-135 scratchpads); adapters without a hidden
   *   filter ignore it
   * @returns Promise that resolves when watching starts
   */
  startWatchingMetadata(
    paths: string[],
    watchId: string,
    options?: { ignore?: IgnoreRulesOption; allowHiddenSubtrees?: string[] },
  ): Promise<void>;

  /**
   * Start or update watching individual files for content changes
   * Automatically reconciles changes: adds new files, removes files no longer in list
   * Pass the complete list of files to watch each time - platform handles reconciliation
   * @param paths - File paths to watch (absolute paths)
   * @param watchId - Unique identifier for this watch session
   * @returns Promise that resolves when watching starts/updates
   */
  startWatchingContent(paths: string[], watchId: string): Promise<void>;

  /**
   * Stop watching paths
   * @param watchId - Unique identifier for the watch session to stop
   * @returns Promise that resolves when watching stops
   */
  stopWatching(watchId: string): Promise<void>;

  /**
   * Subscribe to watcher change events for every active watch session.
   * Events are not scoped per watchId — the platform emits them for the
   * whole app, and callers filter by workspace themselves (see
   * utils/file-sync.ts).
   * @returns Cleanup function to remove the listener
   */
  onFsEvent(listener: FsChangeListener): () => void;

  /**
   * Search content in files within a directory.
   *
   * @param directory - Directory path to search in
   * @param options - Search options
   * @returns Promise resolving to array of search matches
   */
  searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]>;
}

/**
 * Local process surface. Per MET-119 these keep their agent-specific
 * contracts verbatim — they are regrouped here, not generalized.
 */
export interface ProcessSurface {
  /**
   * Create the agent transport for a new task. Desktop spawns the harness as
   * a local child process (Tauri stdio transport); other platforms plug in
   * their own transport here (e.g. a relay transport) without the agent
   * service ever knowing a transport constructor exists.
   */
  createAgentTransport(spec: {
    taskId: string;
    harness: HarnessDefinition;
    workspacePath: string;
    /**
     * Per-task env on top of the harness's static env — e.g. the
     * OPENCODE_CONFIG path registering this task's MCP server
     * (mcpRegistration: "opencode-config").
     */
    extraEnv?: Record<string, string>;
  }): AgentTransport;

  /**
   * Create the endpoint for a task's app-tools MCP server (Stage 3.5) —
   * same construction contract as `createAgentTransport` right above: a
   * dumb constructor that does nothing async. The caller calls `start()`
   * itself and reads `mcpServer` off the returned instance afterward
   * (populated after start, same pattern as `spawnInfo`) to build ACP
   * `session/new.mcpServers` or a harness config. Deliberately not an
   * AgentTransport: harnesses may run several concurrent instances of the
   * server command, so requests arrive with a per-connection `respond`
   * instead of a single line channel (see McpEndpoint). Desktop's instance
   * spawns its own binary as a stdio↔loopback-TCP relay (`McpServer::Stdio`,
   * mandatory per the ACP spec, unlike `http`/`sse`); other platforms plug
   * in their own mechanism without `mcp-server.ts` or `acp-client.ts` ever
   * seeing a port or process.
   */
  createMcpEndpoint(spec: { taskId: string }): McpEndpoint;

  /**
   * Run a script through the user's local login shell and capture its
   * output. A raw execution primitive — this adapter has no notion of what
   * the script does (harness discovery is the first caller, from
   * src/agent/harness-discovery.ts, which owns all script-building and
   * output-parsing). Desktop-only capability: no equivalent exists on a
   * web/relay platform, so non-desktop adapters reject it, same as
   * `createAgentTransport`'s placeholder above.
   */
  runShellCommand(
    script: string,
  ): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * SQLite-backed storage for persisted TanStack DB collections.
 *
 * Driver-level only: the adapter never names a collection. Ids, schemas and
 * `schemaVersion` belong above it, in the entities layer.
 */
export interface DbSurface {
  /**
   * The shared persistence every persisted collection is built on. Synchronous
   * because collections are defined at module scope, and it touches no storage
   * — the database file, and on web the OPFS entry and its worker, are created
   * by the first collection query.
   */
  get(): PersistedCollectionPersistence;
}

/** Window/OS-level shell: dialogs, external links, chrome, platform events. */
export interface PlatformUiSurface {
  /**
   * Opens a directory picker dialog
   * @param title - Title for the picker dialog
   * @returns the selected directory path, or null if cancelled
   */
  pickDirectory(title: string): Promise<string | null>;

  /**
   * Ask the user for a single line of text (e.g. a link URL).
   * window.prompt is not implemented inside the Tauri webview, so callers
   * must go through this affordance instead.
   * @returns the entered text, or null if the user cancelled
   */
  promptText(options: TextPromptOptions): Promise<string | null>;

  /**
   * Open a URL in the system's default browser.
   * @param url — must be http(s) or mailto; other schemes are ignored
   */
  openExternal(url: string): Promise<void>;

  /** Toggle application fullscreen state. */
  toggleFullscreen(): Promise<void>;

  /**
   * Adds a platform event listener.
   * @returns Cleanup function to remove the listener
   */
  addEventListener(callback: PlatformEventListener): () => void;

  /** Removes a platform event listener. */
  removeEventListener(callback: PlatformEventListener): void;
}

/**
 * Platform adapter: one object composed of per-concern surfaces, so each
 * surface is self-contained and can be reasoned about (and swapped) on its
 * own. Construction is synchronous and side-effect free — see the lifecycle
 * invariance note on MET-118.
 *
 * Note `getGitStorageHost` is deliberately absent: the git host is built
 * purely on fs operations and now lives above the adapter, in
 * `createGitStorageHost` (git-storage-host.ts).
 */
export interface IPlatformAdapter {
  fs: FileSystemSurface;
  proc: ProcessSurface;
  db: DbSurface;
  ui: PlatformUiSurface;
  updates: PlatformUpdater;
}
