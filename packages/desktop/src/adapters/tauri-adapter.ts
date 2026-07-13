import type {
  IPlatformAdapter,
  PlatformEventListener,
  PlatformUpdater,
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  MetadataChangeEvent,
  ContentChangeEvent,
  SearchOptions,
  SearchMatch,
  TextPromptOptions,
} from "./platform-adapter.interface";
import { FsError } from "./platform-adapter.interface";
import { requestTextPrompt } from "@/utils/text-prompt";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { GitStorageHost } from "@metrists/git";
import type { HarnessDefinition } from "@metrists/shared/agent";
import type { AgentTransport, McpEndpoint } from "@/agent/agent-transport.interface";
import { TauriStdioTransport } from "@/agent/tauri-stdio-transport";
import { TauriMcpTransport } from "@/agent/tauri-mcp-transport";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * Classify a *thrown* invoke error (capability/scope violations, OS-level
 * throws) into a typed FileSystemError. Rust-mapped errors come back as
 * values, not throws, so string matching is the only signal here.
 */
function classifyInvokeError(path: string, error: unknown): FileSystemError {
  const message = error instanceof Error ? error.message : String(error);
  const isPermission =
    /permission denied|os error 1\b|not allowed|forbidden|scope/i.test(message);
  return new FsError(isPermission ? "permission_denied" : "io_error", path, message);
}

export class TauriPlatformAdapter implements IPlatformAdapter {
  private eventListeners: Set<PlatformEventListener> = new Set();
  private unlistenFns: Promise<UnlistenFn>[] = [];
  private kvStore = new LazyStore("kv.json");
  private gitLocks = new Set<string>();
  private updater: PlatformUpdater | null = null;

  async pickDirectory(title: string): Promise<string | null> {
    const result = await open({
      title: title,
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  async requestWorkspaceAccess(_workspacePath: string): Promise<boolean> {
    // Desktop has no permission prompt to trigger — the user flips the OS
    // setting (macOS Files and Folders) and retries.
    return true;
  }

  async promptText(options: TextPromptOptions): Promise<string | null> {
    // The Tauri dialog plugin has no text-input dialog, and window.prompt is
    // a no-op inside the webview — use the in-app dialog bridge.
    return requestTextPrompt(options);
  }

  openExternal(url: string): Promise<void> {
    // x-apple.systempreferences deep-links into macOS System Settings
    // (e.g. Privacy & Security → Files and Folders for fs re-grants).
    const allowed = /^(https?|mailto):|^x-apple\.systempreferences:/i;
    if (allowed.test(url)) {
      openUrl(url);
    }
    return Promise.resolve();
  }

  async readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
      includeHidden?: boolean;
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
        includeHidden: options?.includeHidden ?? false,
      });

      if (result.ok && result.value) {
        return { ok: true, value: result.value };
      } else {
        return { ok: false, error: result.error! };
      }
    } catch (error) {
      return { ok: false, error: classifyInvokeError(path, error) };
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
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
      return { ok: false, error: classifyInvokeError(oldPath, error) };
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
      };
    }
  }

  async readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>> {
    try {
      const result = await invoke<
        BatchResult<{ path: string; data: number[] }>
      >("read_binary_files", { paths });
      return {
        succeeded: result.succeeded.map((entry) => ({
          path: entry.path,
          data: Uint8Array.from(entry.data),
        })),
        failed: result.failed,
      };
    } catch (error) {
      return {
        succeeded: [],
        failed: paths.map((path) => classifyInvokeError(path, error)),
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
        failed: files.map((file) => classifyInvokeError(file.path, error)),
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
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
      return { ok: false, error: classifyInvokeError(oldPath, error) };
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
      return { ok: false, error: classifyInvokeError(from, error) };
    }
  }

  async writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>> {
    try {
      const result = await invoke<BatchResult<string>>("write_binary_files", {
        files: files.map((f) => ({
          path: f.path,
          data: Array.from(f.data),
        })),
      });
      return result;
    } catch (error) {
      return {
        succeeded: [],
        failed: files.map((f) => classifyInvokeError(f.path, error)),
      };
    }
  }

  async resolveAssetUrl(
    relativePath: string,
    workspacePath: string,
  ): Promise<string> {
    // If path is already absolute, use it directly; otherwise join with workspace
    const absolutePath = relativePath.startsWith("/")
      ? relativePath
      : `${workspacePath}/${relativePath}`.replace(/\/+/g, "/");
    return convertFileSrc(absolutePath);
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
        failed: paths.map((path) => classifyInvokeError(path, error)),
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

  /**
   * Search content in files within a directory, returning all matches.
   */
  async searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]> {
    return invoke<SearchMatch[]>("search_content", {
      directory,
      query: options.query,
      useRegex: options.useRegex ?? false,
      caseSensitive: options.caseSensitive ?? false,
      filePattern: options.filePattern ?? null,
      fileIncludes: options.fileIncludes ?? null,
      maxResults: options.maxResults ?? 1000,
    });
  }

  getGitStorageHost(workspacePath: string): GitStorageHost {
    const toEpochMs = (value: Date | number): number => {
      if (value instanceof Date) {
        return value.getTime();
      }
      return value;
    };

    const requireSuccess = <T>(
      path: string,
      result: BatchResult<T>,
      errorKind: "read" | "write",
    ): T => {
      if (result.succeeded.length > 0) {
        return result.succeeded[0];
      }

      const failed = result.failed[0];
      const reason = failed?.message ?? "Unknown error";
      throw new Error(`Git host ${errorKind} failed for '${path}': ${reason}`);
    };

    const host: GitStorageHost = {
      readFile: async (path: string): Promise<Uint8Array> => {
        const result = await this.readBinaryFiles([path]);
        const entry = requireSuccess(path, result, "read");
        return entry.data;
      },

      writeFileAtomic: async (
        path: string,
        data: Uint8Array,
      ): Promise<void> => {
        const result = await this.writeBinaryFiles([{ path, data }]);
        requireSuccess(path, result, "write");
      },

      renameAtomic: async (from: string, to: string): Promise<void> => {
        const result = await this.moveFile(from, to);
        if (!result.ok) {
          throw new Error(
            `Git host rename failed for '${from}' -> '${to}': ${result.error.message}`,
          );
        }
      },

      deleteFile: async (path: string): Promise<void> => {
        const result = await this.deleteFiles([path]);
        requireSuccess(path, result, "write");
      },

      stat: async (path: string) => {
        const exists = await this.exists([path]);
        const entry = exists[0];
        if (!entry?.exists) {
          return {
            exists: false as const,
            isFile: false as const,
            isDir: false as const,
          };
        }

        const metadataResult = await this.getMetadata([path]);
        const metadata = requireSuccess(path, metadataResult, "read");
        const isDir = metadata.type === "directory";

        return {
          exists: true as const,
          isFile: !isDir,
          isDir,
          size: metadata.size,
          mode: isDir ? 0o040755 : 0o100644,
          mtimeMs: toEpochMs(metadata.modifiedAt),
        };
      },

      lstat: async (path: string) => {
        const info = await host.stat(path);
        if (!info.exists) {
          return {
            exists: false as const,
            isFile: false as const,
            isDir: false as const,
            isSymbolicLink: false as const,
          };
        }

        return {
          ...info,
          isSymbolicLink: false,
        };
      },

      readDir: async (path: string) => {
        const result = await this.readDirectory(path, {
          recursive: false,
          includeFiles: true,
          includeDirectories: true,
          includeHidden: true,
        });

        if (!result.ok) {
          throw new Error(
            `Git host readdir failed for '${path}': ${result.error.message}`,
          );
        }

        const childExists = await this.exists(result.value);
        return childExists
          .filter((entry) => entry.exists)
          .map((entry) => ({
            name: entry.path.split("/").filter(Boolean).pop() ?? entry.path,
            isFile: entry.type === "file",
            isDir: entry.type === "directory",
            isSymbolicLink: false,
          }));
      },

      createDir: async (path: string): Promise<void> => {
        const result = await this.createDirectories([path]);
        requireSuccess(path, result, "write");
      },

      removeDir: async (path: string): Promise<void> => {
        const result = await this.deleteDirectories([path], {
          recursive: false,
        });
        requireSuccess(path, result, "write");
      },

      readLink: async () => {
        throw new Error("Git host readLink is not supported on this adapter.");
      },

      createSymlink: async () => {
        throw new Error(
          "Git host createSymlink is not supported on this adapter.",
        );
      },

      chmod: async () => {
        throw new Error("Git host chmod is not supported on this adapter.");
      },

      lock: async (name: string): Promise<void> => {
        const key = `${workspacePath}::${name}`;
        if (this.gitLocks.has(key)) {
          throw new Error(`Git lock '${name}' is already held.`);
        }
        this.gitLocks.add(key);
      },

      unlock: async (name: string): Promise<void> => {
        this.gitLocks.delete(`${workspacePath}::${name}`);
      },
    };

    return host;
  }

  createAgentTransport(spec: {
    taskId: string;
    harness: HarnessDefinition;
    workspacePath: string;
    extraEnv?: Record<string, string>;
  }): AgentTransport {
    return new TauriStdioTransport({
      procId: spec.taskId,
      program: spec.harness.command,
      // `${workspace}` placeholder → the actual workspace path (e.g.
      // OpenCode's `acp --cwd ${workspace}`).
      args: spec.harness.args.map((arg) =>
        arg.split("${workspace}").join(spec.workspacePath),
      ),
      cwd: spec.workspacePath,
      env: { ...spec.harness.env, ...spec.extraEnv },
    });
  }

  createMcpEndpoint(spec: { taskId: string }): McpEndpoint {
    return new TauriMcpTransport(spec.taskId);
  }

  getUpdater(): PlatformUpdater {
    if (this.updater) {
      return this.updater;
    }

    let pendingUpdate: Awaited<
      ReturnType<Awaited<typeof import("@tauri-apps/plugin-updater")>["check"]>
    > = null;

    this.updater = {
      check: async () => {
        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check();

          if (!update) {
            pendingUpdate = null;
            return {
              status: "up-to-date",
              flow: "download-restart",
            };
          }

          pendingUpdate = update;

          return {
            status: "available",
            flow: "download-restart",
            version: update.version,
            body: update.body ?? undefined,
          };
        } catch (error) {
          return {
            status: "error",
            error:
              error instanceof Error ? error.message : "UPDATE_CHECK_FAILED",
          };
        }
      },
      apply: async function* () {
        if (!pendingUpdate) {
          yield {
            status: "error",
            error: "NO_PENDING_UPDATE",
          };
          return;
        }

        let total: number | null = null;

        yield {
          status: "downloading",
          downloaded: 0,
          total: null,
        };

        try {
          await pendingUpdate.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
            }
          });

          pendingUpdate = null;

          if (total !== null) {
            yield {
              status: "downloading",
              downloaded: total,
              total,
            };
          }

          yield {
            status: "ready",
          };
        } catch (error) {
          yield {
            status: "error",
            error:
              error instanceof Error ? error.message : "UPDATE_DOWNLOAD_FAILED",
          };
        }
      },
      restart: async () => {
        try {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
          return { status: "restarted" };
        } catch (error) {
          return {
            status: "error",
            error: error instanceof Error ? error.message : "RELAUNCH_FAILED",
          };
        }
      },
    };

    return this.updater;
  }

  private cleanupListeners(): void {
    this.unlistenFns.forEach((unlistenPromise) => {
      unlistenPromise.then((unlisten) => unlisten());
    });
    this.unlistenFns = [];
  }
}
