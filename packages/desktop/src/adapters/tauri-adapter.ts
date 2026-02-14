import type {
  IPlatformAdapter,
  PlatformEventListener,
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  FileSystemChangeEvent,
} from "./platform-adapter.interface";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri platform adapter
 * Implements platform-specific operations for Tauri desktop environment
 * Delegates file operations to Rust backend for performance and native file system access
 */
export class TauriPlatformAdapter implements IPlatformAdapter {
  private eventListeners: Set<PlatformEventListener> = new Set();
  private unlistenFns: Promise<UnlistenFn>[] = [];
  private fileWatchers: Map<string, () => void> = new Map();

  // ========== Directory Picker ==========

  async pickDirectory(title: string): Promise<string | null> {
    const result = await open({
      title: title,
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  // ========== Directory Operations ==========

  async readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
    },
  ): Promise<Result<string[]>> {
    try {
      const result = await invoke<{
        ok: boolean;
        value?: string[];
        error?: FileSystemError;
      }>("read_directory", {
        path,
        recursive: options?.recursive ?? false,
        includeFiles: options?.includeFiles ?? true,
        includeDirectories: options?.includeDirectories ?? true,
      });

      if (result.ok && result.value) {
        return { ok: true, value: result.value };
      } else {
        return { ok: false, error: result.error! };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  async createDirectories(paths: string[]): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("create_directories", {
        paths,
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("delete_directories", {
        paths,
        recursive: options?.recursive ?? false,
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async moveDirectory(oldPath: string, newPath: string): Promise<Result<void>> {
    try {
      const result = await invoke<{ ok: boolean; error?: FileSystemError }>(
        "move_directory",
        { oldPath, newPath },
      );

      if (result.ok) {
        return { ok: true, value: undefined };
      } else {
        return { ok: false, error: result.error! };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          path: oldPath,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  // ========== File Operations ==========

  async readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>> {
    try {
      const result = await invoke<
        BatchResult<{ path: string; content: string }>
      >("read_files", { paths });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("write_files", {
        files,
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: files.map((file) => ({
          path: file.path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async createFiles(paths: string[]): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("create_files", {
        paths,
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async deleteFiles(paths: string[]): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("delete_files", {
        paths,
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  async moveFile(oldPath: string, newPath: string): Promise<Result<void>> {
    try {
      const result = await invoke<{ ok: boolean; error?: FileSystemError }>(
        "move_file",
        { oldPath, newPath },
      );

      if (result.ok) {
        return { ok: true, value: undefined };
      } else {
        return { ok: false, error: result.error! };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          path: oldPath,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  async copyFile(from: string, to: string): Promise<Result<void>> {
    try {
      const result = await invoke<{ ok: boolean; error?: FileSystemError }>(
        "copy_file",
        { from, to },
      );

      if (result.ok) {
        return { ok: true, value: undefined };
      } else {
        return { ok: false, error: result.error! };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          path: from,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  // ========== Metadata & Existence ==========

  async exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]> {
    try {
      const result = await invoke<
        { path: string; exists: boolean; type?: "file" | "directory" }[]
      >("check_exists", { paths });
      return result;
    } catch {
      // On error, mark all as non-existent
      return paths.map((path) => ({ path, exists: false }));
    }
  }

  async getMetadata(paths: string[]): Promise<BatchResult<FileSystemMetadata>> {
    try {
      const result = await invoke<BatchResult<FileSystemMetadata>>(
        "get_metadata",
        { paths },
      );
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => ({
          path,
          type: "io_error",
          message: error instanceof Error ? error.message : "Unknown error",
        })),
      };
    }
  }

  // ========== File Watching ==========

  watchPaths(
    paths: string[],
    callback: (event: FileSystemChangeEvent) => void,
  ): () => void {
    const watchId = Math.random().toString(36);

    // Set up Tauri file watcher
    invoke("watch_paths", { paths, watchId })
      .then(() => {
        // Listen for file change events
        const unlisten = listen(`fs-change-${watchId}`, (event) => {
          callback(event.payload as FileSystemChangeEvent);
        });
        this.unlistenFns.push(unlisten);
      })
      .catch((error) => {
        console.error("Failed to set up file watcher:", error);
      });

    // Return cleanup function
    const cleanup = () => {
      invoke("unwatch_paths", { watchId }).catch((error) => {
        console.error("Failed to clean up file watcher:", error);
      });
      this.fileWatchers.delete(watchId);
    };

    this.fileWatchers.set(watchId, cleanup);
    return cleanup;
  }

  // ========== Event Listeners ==========

  addEventListener(callback: PlatformEventListener): () => void {
    this.eventListeners.add(callback);

    // Set up listeners if this is the first callback
    if (this.eventListeners.size === 1) {
      this.setupListeners();
    }

    // Return cleanup function
    return () => {
      this.removeEventListener(callback);
    };
  }

  removeEventListener(callback: PlatformEventListener): void {
    this.eventListeners.delete(callback);

    // Clean up listeners if no more callbacks
    if (this.eventListeners.size === 0) {
      this.cleanupListeners();
    }
  }

  /**
   * Set up Tauri event listeners
   */
  private setupListeners(): void {
    // Listen for theme changes
    const themeUnlisten = listen("theme-changed", (event) => {
      const theme = event.payload as any;
      this.eventListeners.forEach((callback) => {
        callback({ type: "theme-changed", payload: theme });
      });
    });
    this.unlistenFns.push(themeUnlisten);

    // Listen for folder selection
    const folderUnlisten = listen("folder-selected", (event) => {
      const folderPath = event.payload as string;
      this.eventListeners.forEach((callback) => {
        callback({ type: "folder-selected", payload: folderPath });
      });
    });
    this.unlistenFns.push(folderUnlisten);

    // Listen for file drops
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          this.eventListeners.forEach((callback) => {
            callback({
              type: "file-dropped",
              payload: (event.payload as any as { paths: string[] }).paths,
            });
          });
        }
      })
      .then((unlisten) => this.unlistenFns.push(Promise.resolve(unlisten)));
  }

  /**
   * Clean up Tauri event listeners
   */
  private cleanupListeners(): void {
    this.unlistenFns.forEach((unlistenPromise) => {
      unlistenPromise.then((unlisten) => unlisten());
    });
    this.unlistenFns = [];

    // Clean up file watchers
    this.fileWatchers.forEach((cleanup) => cleanup());
    this.fileWatchers.clear();
  }
}
