import type { Theme } from "@/components/theme-provider";

/**
 * Error types for file system operations
 */
export type FileSystemErrorType =
  | "not_found"
  | "permission_denied"
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
 * Platform events that can be emitted
 */
export type PlatformEvent =
  | { type: "theme-changed"; payload: Theme }
  | { type: "folder-selected"; payload: string }
  | { type: "file-dropped"; payload: string[] }
  | { type: "fs-metadata-changed"; payload: MetadataChangeEvent }
  | { type: "fs-content-changed"; payload: ContentChangeEvent };

/**
 * Generic event listener callback
 */
export type PlatformEventListener = (event: PlatformEvent) => void;

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
}
