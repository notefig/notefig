import type { Theme } from "@/components/theme-provider";
import type { GitStorageHost } from "@metrists/git";
import type { HarnessDefinition } from "@metrists/shared/agent";
import type { AgentTransport } from "@/agent/agent-transport.interface";

/**
 * Error types for file system operations
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

/**
 * File system operation error
 */
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

/**
 * Result type for operations that can fail
 */
export type Result<T, E = FileSystemError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Batch operation result with partial success/failure
 */
export type BatchResult<T> = {
  succeeded: T[];
  failed: FileSystemError[];
};

/**
 * File system metadata
 */
export type FileSystemMetadata = {
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: Date;
  createdAt: Date;
};

/**
 * Options for the single-line text prompt affordance
 */
export type TextPromptOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
};

/**
 * Metadata change event (batched)
 */
export type MetadataChange = {
  type: "created" | "deleted" | "renamed";
  path: string;
  oldPath?: string; // For rename events
  isDirectory: boolean;
};

export type MetadataChangeEvent = {
  changes: MetadataChange[];
};

/**
 * Content change event (batched)
 */
export type ContentChange = {
  path: string;
  content: string;
  contentHash: string;
};

export type ContentChangeEvent = {
  changes: ContentChange[];
};

/**
 * Search options for workspace-wide search
 */
export type SearchOptions = {
  /** Search query string */
  query: string;
  /** Treat query as regex pattern */
  useRegex?: boolean;
  /** Case-sensitive search */
  caseSensitive?: boolean;
  /** File pattern filter (e.g., "*.md", "*.txt") */
  filePattern?: string;
  /** Limit search to these file paths only. If omitted, adapter discovers files itself. */
  fileIncludes?: string[];
  /** Maximum number of results (default: 1000) */
  maxResults?: number;
};

/**
 * Position in a file (1-indexed)
 */
export type FilePosition = {
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column number */
  column: number;
};

/**
 * Location of a search match
 */
export type SearchMatchLocation = {
  /** Absolute path to the file */
  filePath: string;
  /** Range of the match */
  range: {
    start: FilePosition;
    end: FilePosition;
  };
};

/**
 * Content and context of a search match
 */
export type SearchMatchContent = {
  /** The matched text */
  matchText: string;
  /** Full content of the line containing the match */
  lineContent: string;
  /** Lines before the match (for context) */
  beforeContext: string[];
  /** Lines after the match (for context) */
  afterContext: string[];
};

/**
 * A single search match result
 */
export type SearchMatch = {
  /** Where the match was found */
  location: SearchMatchLocation;
  /** What was matched and surrounding context */
  content: SearchMatchContent;
};

/**
 * Platform events that can be emitted
 */
export type PlatformEvent =
  | { type: "theme-changed"; payload: Theme }
  | { type: "folder-selected"; payload: string }
  | { type: "file-dropped"; payload: string[] }
  | { type: "fs-metadata-changed"; payload: MetadataChangeEvent }
  | { type: "fs-content-changed"; payload: ContentChangeEvent }
  | { type: "zoom-changed"; payload: number };

/**
 * Generic event listener callback
 */
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
 * Platform adapter interface
 * Provides a unified interface for platform-specific operations
 * (Tauri vs Browser)
 */
export interface IPlatformAdapter {
  // ========== Directory Picker ==========
  /**
   * Opens a directory picker dialog
   * @param title - Title for the picker dialog
   * @returns Promise that resolves to the selected directory path or null if cancelled
   */
  pickDirectory(title: string): Promise<string | null>;

  // ========== Workspace Access ==========
  /**
   * (Re)acquire access to a workspace folder after a permission failure.
   * On web this MUST run inside a user gesture (it calls
   * handle.requestPermission); elsewhere it's a no-op returning true.
   */
  requestWorkspaceAccess(workspacePath: string): Promise<boolean>;

  // ========== Text Prompt ==========
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

  // ========== Directory Operations ==========
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

  // ========== File Operations ==========
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

  // ========== Metadata & Existence ==========
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

  // ========== File Watching ==========
  /**
   * Start watching directories for metadata changes (creates, deletes, renames)
   * Watches recursively - will detect all changes within the directory tree
   * @param paths - Directory paths to watch
   * @param watchId - Unique identifier for this watch session
   * @returns Promise that resolves when watching starts
   */
  startWatchingMetadata(paths: string[], watchId: string): Promise<void>;

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

  // ========== Event Listeners ==========
  /**
   * Adds a generic platform event listener
   * @param callback - Function to call when events are emitted
   * @returns Cleanup function to remove the listener
   */
  addEventListener(callback: PlatformEventListener): () => void;

  /**
   * Removes a platform event listener
   * @param callback - The callback function to remove
   */
  removeEventListener(callback: PlatformEventListener): void;

  /**
   * Get a value from a namespaced key-value store.
   * @param namespace - The namespace/category for the key
   * @param key - The key within the namespace
   * @returns The stored value, or undefined if not found.
   */
  getKv<T>(namespace: string, key: string): Promise<T | undefined>;

  /**
   * Set a value in a namespaced key-value store.
   * @param namespace - The namespace/category for the key
   * @param key - The key within the namespace
   * @param value - The value to store
   */
  setKv<T>(namespace: string, key: string, value: T): Promise<void>;

  /**
   * Delete a key from a namespaced key-value store.
   * @param namespace - The namespace/category for the key
   * @param key - The key to delete
   */
  deleteKv(namespace: string, key: string): Promise<void>;

  /**
   * Get all values from a namespaced key-value store.
   * @param namespace - The namespace/category
   * @returns Record of all key-value pairs in the namespace
   */
  getAllKv<T>(namespace: string): Promise<Record<string, T>>;

  /**
   * Toggle application fullscreen state.
   */
  toggleFullscreen(): Promise<void>;

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

  /**
   * Create a GitStorageHost bound to a workspace root.
   * This enables one-line Git service initialization per workspace.
   */
  getGitStorageHost(workspacePath: string): GitStorageHost;

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
  }): AgentTransport;

  /**
   * Create the transport for a task's MCP connection (Stage 3.5) — the exact
   * same shape and contract as `createAgentTransport` right above: a dumb
   * constructor that does nothing async and knows nothing about starting.
   * The caller calls `start()` itself and reads `AgentTransport.mcpServer`
   * off the returned instance afterward (populated after start, same pattern
   * as `spawnInfo`) to build ACP `session/new.mcpServers`. Desktop's instance
   * spawns its own binary as a stdio↔loopback-TCP relay (`McpServer::Stdio`,
   * mandatory per the ACP spec, unlike `http`/`sse`); other platforms plug in
   * their own mechanism without `mcp-server.ts` or `acp-client.ts` ever
   * seeing a port or process.
   */
  createMcpTransport(spec: { taskId: string }): AgentTransport;

  /**
   * Create updater actions for the current platform.
   */
  getUpdater(): PlatformUpdater;
}
