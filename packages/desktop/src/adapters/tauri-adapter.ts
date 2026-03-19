import type {
  IPlatformAdapter,
  PlatformEventListener,
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  MetadataChangeEvent,
  ContentChangeEvent,
} from "./platform-adapter.interface";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";

export class TauriPlatformAdapter implements IPlatformAdapter {
  private eventListeners: Set<PlatformEventListener> = new Set();
  private unlistenFns: Promise<UnlistenFn>[] = [];
  private kvStore = new LazyStore("kv.json");

  async pickDirectory(title: string): Promise<string | null> {
    const result = await open({
      title: title,
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

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

  async startWatchingMetadata(paths: string[], watchId: string): Promise<void> {
    try {
      await invoke("start_watching_metadata", { paths, watchId });
    } catch (error) {
      console.error("Failed to start watching metadata:", error);
      throw error;
    }
  }

  async startWatchingContent(paths: string[], watchId: string): Promise<void> {
    try {
      await invoke("start_watching_content", { paths, watchId });
    } catch (error) {
      console.error("Failed to start watching content:", error);
      throw error;
    }
  }

  async stopWatching(watchId: string): Promise<void> {
    try {
      await invoke("stop_watching", { watchId });
    } catch (error) {
      // Silently handle errors - watcher may not exist due to race conditions
      // This is expected during cleanup when watchers haven't fully initialized
    }
  }

  addEventListener(callback: PlatformEventListener): () => void {
    this.eventListeners.add(callback);

    if (this.eventListeners.size === 1) {
      this.setupListeners();
    }

    return () => {
      this.removeEventListener(callback);
    };
  }

  removeEventListener(callback: PlatformEventListener): void {
    this.eventListeners.delete(callback);

    if (this.eventListeners.size === 0) {
      this.cleanupListeners();
    }
  }

  private setupListeners(): void {
    const themeUnlisten = listen("theme-changed", (event) => {
      const theme = event.payload as any;
      this.eventListeners.forEach((callback) => {
        callback({ type: "theme-changed", payload: theme });
      });
    });
    this.unlistenFns.push(themeUnlisten);

    const folderUnlisten = listen("folder-selected", (event) => {
      const folderPath = event.payload as string;
      this.eventListeners.forEach((callback) => {
        callback({ type: "folder-selected", payload: folderPath });
      });
    });
    this.unlistenFns.push(folderUnlisten);

    const metadataUnlisten = listen("fs-metadata-changed", (event) => {
      const payload = event.payload as MetadataChangeEvent;
      this.eventListeners.forEach((callback) => {
        callback({ type: "fs-metadata-changed", payload });
      });
    });
    this.unlistenFns.push(metadataUnlisten);

    const contentUnlisten = listen("fs-content-changed", (event) => {
      const payload = event.payload as ContentChangeEvent;
      this.eventListeners.forEach((callback) => {
        callback({ type: "fs-content-changed", payload });
      });
    });
    this.unlistenFns.push(contentUnlisten);

    const zoomUnlisten = listen("zoom-changed", (event) => {
      const zoom = event.payload as number;
      this.eventListeners.forEach((callback) => {
        callback({ type: "zoom-changed", payload: zoom });
      });
    });
    this.unlistenFns.push(zoomUnlisten);

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

  private buildKvKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  async getKv<T>(namespace: string, key: string): Promise<T | undefined> {
    const fullKey = this.buildKvKey(namespace, key);
    const value = await this.kvStore.get<T>(fullKey);
    return value ?? undefined;
  }

  async setKv<T>(namespace: string, key: string, value: T): Promise<void> {
    const fullKey = this.buildKvKey(namespace, key);
    await this.kvStore.set(fullKey, value);
  }

  async deleteKv(namespace: string, key: string): Promise<void> {
    const fullKey = this.buildKvKey(namespace, key);
    await this.kvStore.delete(fullKey);
  }

  async getAllKv<T>(namespace: string): Promise<Record<string, T>> {
    const allEntries = await this.kvStore.entries<T>();
    const prefix = `${namespace}:`;
    const result: Record<string, T> = {};

    for (const [key, value] of allEntries) {
      if (key.startsWith(prefix)) {
        const shortKey = key.slice(prefix.length);
        result[shortKey] = value;
      }
    }
    return result;
  }

  async toggleFullscreen(): Promise<void> {
    const window = getCurrentWindow();
    const isFullscreen = await window.isFullscreen();
    await window.setFullscreen(!isFullscreen);
  }

  private cleanupListeners(): void {
    this.unlistenFns.forEach((unlistenPromise) => {
      unlistenPromise.then((unlisten) => unlisten());
    });
    this.unlistenFns = [];
  }
}
