import type {
  DbSurface,
  FileSystemSurface,
  FsChangeListener,
  IPlatformAdapter,
  PlatformEvent,
  PlatformEventListener,
  PlatformUiSurface,
  PlatformUpdater,
  ProcessSurface,
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  MetadataChangeEvent,
  ContentChangeEvent,
  SearchOptions,
  SearchMatch,
  TextPromptOptions,
  IgnoreRulesOption,
} from "./platform-adapter.interface";
import { FsError } from "./platform-adapter.interface";
import { createTauriDb } from "./tauri-db";
import { requestTextPrompt } from "@/utils/text-prompt";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { HarnessDefinition } from "@notefig/shared/agent";
import type {
  AgentTransport,
  McpEndpoint,
} from "@notefig/agent";
import { TauriStdioTransport } from "@/agent/tauri-stdio-transport";
import { TauriMcpTransport } from "@/agent/tauri-mcp-transport";

import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Classify a *thrown* invoke error (capability/scope violations, OS-level
 * throws) into a typed FileSystemError. Rust-mapped errors come back as
 * values, not throws, so string matching is the only signal here.
 */
function classifyInvokeError(path: string, error: unknown): FileSystemError {
  const message = error instanceof Error ? error.message : String(error);
  const isPermission =
    /permission denied|os error 1\b|not allowed|forbidden|scope/i.test(message);
  return new FsError(
    isPermission ? "permission_denied" : "io_error",
    path,
    message,
  );
}

/**
 * Ignore config as Rust command args. Absent ⇒ nulls, i.e. no filtering —
 * the shape every caller that must see the complete tree (git storage
 * host) gets by simply not passing `ignore`.
 */
function ignoreArgs(ignore?: IgnoreRulesOption): {
  ignoreDirectories: string[] | null;
  ignoreExtensions: string[] | null;
} {
  return {
    ignoreDirectories: ignore?.directories ?? null,
    ignoreExtensions: ignore?.extensions ?? null,
  };
}

export class TauriPlatformAdapter implements IPlatformAdapter {
  // Two listener registries, one native subscription. Splitting the bus
  // across the fs and ui surfaces must not change *when* Tauri's `listen()`
  // calls happen, so both registries share one refcount: the native
  // subscriptions are set up when the first listener of either kind arrives
  // and torn down when the last one leaves, exactly as the single bus did.
  private uiListeners: Set<PlatformEventListener> = new Set();
  private fsListeners: Set<FsChangeListener> = new Set();
  private unlistenFns: Promise<UnlistenFn>[] = [];

  readonly fs: FileSystemSurface = {
    requestWorkspaceAccess: this.requestWorkspaceAccess.bind(this),
    readDirectory: this.readDirectory.bind(this),
    createDirectories: this.createDirectories.bind(this),
    deleteDirectories: this.deleteDirectories.bind(this),
    moveDirectory: this.moveDirectory.bind(this),
    readFiles: this.readFiles.bind(this),
    readBinaryFiles: this.readBinaryFiles.bind(this),
    writeFiles: this.writeFiles.bind(this),
    createFiles: this.createFiles.bind(this),
    deleteFiles: this.deleteFiles.bind(this),
    moveFile: this.moveFile.bind(this),
    copyFile: this.copyFile.bind(this),
    writeBinaryFiles: this.writeBinaryFiles.bind(this),
    resolveAssetUrl: this.resolveAssetUrl.bind(this),
    exists: this.exists.bind(this),
    getMetadata: this.getMetadata.bind(this),
    startWatchingMetadata: this.startWatchingMetadata.bind(this),
    startWatchingContent: this.startWatchingContent.bind(this),
    stopWatching: this.stopWatching.bind(this),
    onFsEvent: this.onFsEvent.bind(this),
    searchContent: this.searchContent.bind(this),
  };

  readonly proc: ProcessSurface = {
    createAgentTransport: this.createAgentTransport.bind(this),
    createMcpEndpoint: this.createMcpEndpoint.bind(this),
    runShellCommand: this.runShellCommand.bind(this),
  };

  readonly db: DbSurface = createTauriDb();

  readonly ui: PlatformUiSurface = {
    pickDirectory: this.pickDirectory.bind(this),
    promptText: this.promptText.bind(this),
    openExternal: this.openExternal.bind(this),
    toggleFullscreen: this.toggleFullscreen.bind(this),
    addEventListener: this.addEventListener.bind(this),
    removeEventListener: this.removeEventListener.bind(this),
  };

  // Built once so `check()` and `apply()` share the `pendingUpdate` closure —
  // the same instance the old `getUpdater()` memoized. Construction is a
  // plain object literal (the plugin imports are inside the methods), so
  // building it eagerly does no work at boot.
  readonly updates: PlatformUpdater = this.createUpdater();

  private async pickDirectory(title: string): Promise<string | null> {
    const result = await open({
      title: title,
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  private async requestWorkspaceAccess(
    _workspacePath: string,
  ): Promise<boolean> {
    // Desktop has no permission prompt to trigger — the user flips the OS
    // setting (macOS Files and Folders) and retries.
    return true;
  }

  private async promptText(options: TextPromptOptions): Promise<string | null> {
    // The Tauri dialog plugin has no text-input dialog, and window.prompt is
    // a no-op inside the webview — use the in-app dialog bridge.
    return requestTextPrompt(options);
  }

  private openExternal(url: string): Promise<void> {
    // x-apple.systempreferences deep-links into macOS System Settings
    // (e.g. Privacy & Security → Files and Folders for fs re-grants).
    const allowed = /^(https?|mailto):|^x-apple\.systempreferences:/i;
    if (allowed.test(url)) {
      openUrl(url);
    }
    return Promise.resolve();
  }

  private async readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
      includeHidden?: boolean;
      ignore?: IgnoreRulesOption;
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
        ...ignoreArgs(options?.ignore),
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

  private async createDirectories(
    paths: string[],
  ): Promise<BatchResult<string>> {
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

  private async deleteDirectories(
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

  private async moveDirectory(
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>> {
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

  private async readFiles(
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

  private async readBinaryFiles(
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

  private async writeFiles(
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

  private async createFiles(paths: string[]): Promise<BatchResult<string>> {
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

  private async deleteFiles(paths: string[]): Promise<BatchResult<string>> {
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

  private async moveFile(
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>> {
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

  private async copyFile(from: string, to: string): Promise<Result<void>> {
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

  private async writeBinaryFiles(
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

  private async resolveAssetUrl(
    relativePath: string,
    workspacePath: string,
  ): Promise<string> {
    const absolutePath = relativePath.startsWith("/")
      ? relativePath
      : `${workspacePath}/${relativePath}`.replace(/\/+/g, "/");
    return convertFileSrc(absolutePath);
  }

  private async exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]> {
    try {
      const result = await invoke<
        { path: string; exists: boolean; type?: "file" | "directory" }[]
      >("check_exists", { paths });
      return result;
    } catch {
      return paths.map((path) => ({ path, exists: false }));
    }
  }

  private async getMetadata(
    paths: string[],
  ): Promise<BatchResult<FileSystemMetadata>> {
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

  private async startWatchingMetadata(
    paths: string[],
    watchId: string,
    options?: { ignore?: IgnoreRulesOption },
  ): Promise<void> {
    try {
      await invoke("start_watching_metadata", {
        paths,
        watchId,
        ...ignoreArgs(options?.ignore),
      });
    } catch (error) {
      console.error("Failed to start watching metadata:", error);
      throw error;
    }
  }

  private async startWatchingContent(
    paths: string[],
    watchId: string,
  ): Promise<void> {
    try {
      await invoke("start_watching_content", { paths, watchId });
    } catch (error) {
      console.error("Failed to start watching content:", error);
      throw error;
    }
  }

  private async stopWatching(watchId: string): Promise<void> {
    try {
      await invoke("stop_watching", { watchId });
    } catch (error) {
      // Silently handle errors - watcher may not exist due to race conditions
      // This is expected during cleanup when watchers haven't fully initialized
    }
  }

  /** Total across both registries — drives the native subscribe/unsubscribe. */
  private listenerCount(): number {
    return this.uiListeners.size + this.fsListeners.size;
  }

  private addEventListener(callback: PlatformEventListener): () => void {
    this.uiListeners.add(callback);

    if (this.listenerCount() === 1) {
      this.setupListeners();
    }

    return () => {
      this.removeEventListener(callback);
    };
  }

  private removeEventListener(callback: PlatformEventListener): void {
    this.uiListeners.delete(callback);

    if (this.listenerCount() === 0) {
      this.cleanupListeners();
    }
  }

  private onFsEvent(listener: FsChangeListener): () => void {
    this.fsListeners.add(listener);

    if (this.listenerCount() === 1) {
      this.setupListeners();
    }

    return () => {
      this.fsListeners.delete(listener);

      if (this.listenerCount() === 0) {
        this.cleanupListeners();
      }
    };
  }

  private emitUi(event: PlatformEvent): void {
    this.uiListeners.forEach((callback) => callback(event));
  }

  private setupListeners(): void {
    const themeUnlisten = listen("theme-changed", (event) => {
      const theme = event.payload as any;
      this.emitUi({ type: "theme-changed", payload: theme });
    });
    this.unlistenFns.push(themeUnlisten);

    const folderUnlisten = listen("folder-selected", (event) => {
      const folderPath = event.payload as string;
      this.emitUi({ type: "folder-selected", payload: folderPath });
    });
    this.unlistenFns.push(folderUnlisten);

    const metadataUnlisten = listen("fs-metadata-changed", (event) => {
      const payload = event.payload as MetadataChangeEvent;
      this.fsListeners.forEach((listener) => {
        listener({ type: "fs-metadata-changed", payload });
      });
    });
    this.unlistenFns.push(metadataUnlisten);

    const contentUnlisten = listen("fs-content-changed", (event) => {
      const payload = event.payload as ContentChangeEvent;
      this.fsListeners.forEach((listener) => {
        listener({ type: "fs-content-changed", payload });
      });
    });
    this.unlistenFns.push(contentUnlisten);

    const zoomUnlisten = listen("zoom-changed", (event) => {
      const zoom = event.payload as number;
      this.emitUi({ type: "zoom-changed", payload: zoom });
    });
    this.unlistenFns.push(zoomUnlisten);

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          this.emitUi({
            type: "file-dropped",
            payload: (event.payload as any as { paths: string[] }).paths,
          });
        }
      })
      .then((unlisten) => this.unlistenFns.push(Promise.resolve(unlisten)));
  }

  private async toggleFullscreen(): Promise<void> {
    const window = getCurrentWindow();
    const isFullscreen = await window.isFullscreen();
    await window.setFullscreen(!isFullscreen);
  }

  private async searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]> {
    // Wire format from search.rs. The engine reports raw-file coordinates
    // (that's what a text search is), but they don't cross the adapter
    // surface — the editor can't use them (see SearchTarget).
    type WireMatch = {
      location: { filePath: string };
      content: { matchText: string; lineContent: string };
    };
    const wire = await invoke<WireMatch[]>("search_content", {
      directory,
      query: options.query,
      useRegex: options.useRegex ?? false,
      caseSensitive: options.caseSensitive ?? false,
      filePattern: options.filePattern ?? null,
      fileIncludes: options.fileIncludes ?? null,
      maxResults: options.maxResults ?? 1000,
      ...ignoreArgs(options.ignore),
    });

    // Per-file occurrence counter, keyed by the exact matched text;
    // matches arrive in file order.
    const occurrenceCounts = new Map<string, number>();
    return wire.map((m) => {
      const key = `${m.location.filePath}\u0000${m.content.matchText}`;
      const occurrence = occurrenceCounts.get(key) ?? 0;
      occurrenceCounts.set(key, occurrence + 1);
      return {
        filePath: m.location.filePath,
        matchText: m.content.matchText,
        lineText: m.content.lineContent,
        occurrence,
      };
    });
  }

  private createAgentTransport(spec: {
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

  private createMcpEndpoint(spec: { taskId: string }): McpEndpoint {
    return new TauriMcpTransport(spec.taskId);
  }

  private async runShellCommand(
    script: string,
  ): Promise<{ stdout: string; exitCode: number }> {
    const result = await invoke<
      | { ok: true; value: { stdout: string; exitCode: number | null } }
      | { ok: false; error: { message: string } }
    >("run_shell_command", { script });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return {
      stdout: result.value.stdout,
      exitCode: result.value.exitCode ?? -1,
    };
  }

  private createUpdater(): PlatformUpdater {
    let pendingUpdate: Awaited<
      ReturnType<Awaited<typeof import("@tauri-apps/plugin-updater")>["check"]>
    > = null;

    return {
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
  }

  private cleanupListeners(): void {
    this.unlistenFns.forEach((unlistenPromise) => {
      unlistenPromise.then((unlisten) => unlisten());
    });
    this.unlistenFns = [];
  }
}
