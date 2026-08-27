import type {
  BatchResult,
  DbSurface,
  FileSystemError,
  FileSystemMetadata,
  FileSystemSurface,
  FsChangeListener,
  IPlatformAdapter,
  PlatformUiSurface,
  PlatformUpdater,
  PlatformEventListener,
  ProcessSurface,
  Result,
  SearchMatch,
  SearchOptions,
  TextPromptOptions,
  IgnoreRulesOption,
} from "./platform-adapter.interface";
import { createBrowserDb } from "./browser-db";
import { requestTextPrompt } from "@/utils/text-prompt";
import type { HarnessDefinition } from "@notefig/shared/agent";
import type {
  AgentTransport,
  McpEndpoint,
} from "@notefig/agent";
import { tunnelConnection } from "@/agent/tunnel/tunnel-connection";
import { TunnelTransport } from "@/agent/tunnel/tunnel-transport";
import { TunnelMcpEndpoint } from "@/agent/tunnel/tunnel-mcp-endpoint";

export function createError(
  path: string,
  type: FileSystemError["type"],
  message: string,
): FileSystemError {
  return { path, type, message };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`);
}

const BINARY_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "svg",
  "webp",
  "ico",
  "tiff",
  "tif",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "wma",
  "zip",
  "tar",
  "gz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "app",
  "db",
  "sqlite",
  "sqlite3",
  "lock",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
]);

function isBinaryByExtension(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

const UPDATER_MANIFEST_URL = "https://app.notefig.com/latest.json";

function normalizeVersion(version: string): number[] {
  const sanitized = version.trim().replace(/^v/i, "");
  return sanitized
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isRemoteVersionNewer(
  remoteVersion: string,
  currentVersion: string,
): boolean {
  const remote = normalizeVersion(remoteVersion);
  const current = normalizeVersion(currentVersion);
  const length = Math.max(remote.length, current.length);

  for (let index = 0; index < length; index += 1) {
    const remotePart = remote[index] ?? 0;
    const currentPart = current[index] ?? 0;
    if (remotePart > currentPart) return true;
    if (remotePart < currentPart) return false;
  }

  return false;
}

function extractManifestInfo(payload: unknown): {
  version: string;
  body?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const maybeRecord = payload as Record<string, unknown>;
  const version = maybeRecord.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    return null;
  }

  const notes = maybeRecord.notes;
  const body = typeof notes === "string" ? notes : undefined;

  return {
    version,
    body,
  };
}

function getCurrentAppVersion(): string {
  if (
    typeof __APP_VERSION__ === "string" &&
    __APP_VERSION__.trim().length > 0
  ) {
    return __APP_VERSION__;
  }

  return "0.0.0";
}

export abstract class BaseBrowserAdapter implements IPlatformAdapter {
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

  // Shared by both web variants — the OPFS database is per-origin.
  readonly db: DbSurface = createBrowserDb();

  readonly ui: PlatformUiSurface = {
    pickDirectory: this.pickDirectory.bind(this),
    promptText: this.promptText.bind(this),
    openExternal: this.openExternal.bind(this),
    toggleFullscreen: this.toggleFullscreen.bind(this),
    addEventListener: this.addEventListener.bind(this),
    removeEventListener: this.removeEventListener.bind(this),
  };

  readonly updates: PlatformUpdater = this.createUpdater();

  protected abstract pickDirectory(title: string): Promise<string | null>;

  // The pure-IndexedDB adapter has no permission surface; the FS Access
  // adapter overrides this.
  protected async requestWorkspaceAccess(
    _workspacePath: string,
  ): Promise<boolean> {
    return true;
  }

  protected async promptText(
    options: TextPromptOptions,
  ): Promise<string | null> {
    // Same in-app dialog on the web — consistent UX, no native prompt.
    return requestTextPrompt(options);
  }

  protected openExternal(url: string): Promise<void> {
    const allowed = /^(https?|mailto):/i;
    if (allowed.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    return Promise.resolve();
  }
  protected abstract readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
      includeHidden?: boolean;
      ignore?: IgnoreRulesOption;
    },
  ): Promise<Result<string[]>>;
  protected abstract createDirectories(
    paths: string[],
  ): Promise<BatchResult<string>>;
  protected abstract deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>>;
  protected abstract moveDirectory(
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>>;
  protected abstract readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>>;
  protected abstract readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>>;
  protected abstract writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>>;
  protected abstract deleteFiles(paths: string[]): Promise<BatchResult<string>>;
  protected abstract writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>>;
  protected abstract resolveAssetUrl(
    relativePath: string,
    workspacePath: string,
  ): Promise<string>;
  protected abstract exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]>;
  protected abstract getMetadata(
    paths: string[],
  ): Promise<BatchResult<FileSystemMetadata>>;

  // The three helpers below are *composed* from fs primitives rather than
  // implemented per platform, so they go through `this.fs` — the surface is
  // the contract, and a subclass override is picked up through it either way.
  protected async createFiles(paths: string[]): Promise<BatchResult<string>> {
    return this.fs.writeFiles(paths.map((path) => ({ path, content: "" })));
  }

  protected async moveFile(
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>> {
    const readResult = await this.fs.readBinaryFiles([oldPath]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(oldPath, "not_found", "File not found"),
      };
    }
    const data = readResult.succeeded[0].data;
    const writeResult = await this.fs.writeBinaryFiles([
      { path: newPath, data },
    ]);
    if (writeResult.failed.length > 0) {
      return {
        ok: false,
        error: writeResult.failed[0],
      };
    }
    await this.fs.deleteFiles([oldPath]);
    return { ok: true, value: undefined };
  }

  protected async copyFile(from: string, to: string): Promise<Result<void>> {
    const readResult = await this.fs.readBinaryFiles([from]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(from, "not_found", "File not found"),
      };
    }
    const writeResult = await this.fs.writeBinaryFiles([
      { path: to, data: readResult.succeeded[0].data },
    ]);
    if (writeResult.failed.length > 0) {
      return { ok: false, error: writeResult.failed[0] };
    }
    return { ok: true, value: undefined };
  }

  protected async startWatchingMetadata(
    _paths: string[],
    _watchId: string,
    _options?: { ignore?: IgnoreRulesOption; allowHiddenSubtrees?: string[] },
  ): Promise<void> {
    // TODO: Implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserAdapter] Metadata watching not yet implemented");
  }

  protected async startWatchingContent(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: Implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserAdapter] Content watching not yet implemented");
  }

  protected async stopWatching(_watchId: string): Promise<void> {
    // No-op
  }

  protected addEventListener(_callback: PlatformEventListener): () => void {
    // No window/OS event source on the web — theme, zoom and drag-drop are
    // handled by the DOM directly, not routed through the adapter.
    return () => {};
  }

  protected removeEventListener(_callback: PlatformEventListener): void {
    // No-op in browser
  }

  // No watcher on the pure-IndexedDB adapter; the FS Access adapter
  // overrides this with its polling watcher.
  protected onFsEvent(_listener: FsChangeListener): () => void {
    return () => {};
  }

  protected async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  }

  protected abstract searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]>;

  protected createAgentTransport(spec: {
    taskId: string;
    harness: HarnessDefinition;
    workspacePath: string;
    extraEnv: Record<string, string>;
  }): AgentTransport {
    // Agents on web run on a paired `notefig agent` worker: the harness is
    // a child process there and its ACP stdio tunnels through as bytes. No
    // worker paired ⇒ no agent runtime (files still work via this adapter,
    // but there's nothing to spawn the agent on).
    if (tunnelConnection.getState().status === "connected") {
      return new TunnelTransport(spec);
    }
    throw new Error(
      "Agents need a paired machine on the web — run `notefig agent` and pair.",
    );
  }

  protected createMcpEndpoint(spec: { taskId: string }): McpEndpoint {
    if (tunnelConnection.getState().status === "connected") {
      return new TunnelMcpEndpoint(spec.taskId);
    }
    throw new Error(
      "Agents need a paired machine on the web — run `notefig agent` and pair.",
    );
  }

  protected async runShellCommand(
    _script: string,
  ): Promise<{ stdout: string; exitCode: number }> {
    // Not a future-parity gap like the two above — running arbitrary local
    // shell scripts from a browser sandbox is categorically impossible.
    // Callers (harness-discovery.ts) treat this rejection the same as "found
    // nothing locally".
    throw new Error("Shell commands are not supported on this adapter.");
  }

  protected createUpdater(): PlatformUpdater {
    return {
      check: async () => {
        try {
          const response = await fetch(UPDATER_MANIFEST_URL, {
            cache: "no-store",
          });

          if (!response.ok) {
            return {
              status: "error",
              error: `HTTP_${response.status}`,
            };
          }

          const payload = (await response.json()) as unknown;
          const manifest = extractManifestInfo(payload);

          if (!manifest) {
            return {
              status: "error",
              error: "INVALID_MANIFEST",
            };
          }

          if (isRemoteVersionNewer(manifest.version, getCurrentAppVersion())) {
            return {
              status: "available",
              flow: "refresh",
              version: manifest.version,
              body: manifest.body,
            };
          }

          return {
            status: "up-to-date",
            flow: "refresh",
          };
        } catch {
          return {
            status: "error",
            error: "NETWORK_ERROR",
          };
        }
      },
      apply: async function* () {
        yield { status: "applied" };
      },
      restart: async () => {
        window.location.reload();
        return { status: "restarted" };
      },
    };
  }
}

/**
 * Filter file paths by search options (file pattern, file includes, binary).
 * Exported for reuse by adapter search implementations.
 */
export function filterFilePaths(
  paths: string[],
  options: SearchOptions,
): string[] {
  let filtered = paths;

  if (options.fileIncludes?.length) {
    const includeSet = new Set(options.fileIncludes);
    filtered = filtered.filter((p) => includeSet.has(p));
  }

  if (options.filePattern) {
    const patternRegex = globToRegex(options.filePattern);
    filtered = filtered.filter((p) => {
      const fileName = p.split("/").pop() ?? "";
      return patternRegex.test(fileName);
    });
  }

  filtered = filtered.filter((p) => !isBinaryByExtension(p));

  return filtered;
}

/**
 * Build a search RegExp from SearchOptions.
 * Returns null if the regex is invalid.
 */
export function buildSearchPattern(options: SearchOptions): RegExp | null {
  try {
    const source = options.useRegex
      ? options.query
      : escapeRegex(options.query);
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function searchFileContent(
  filePath: string,
  content: string,
  pattern: RegExp,
): SearchMatch[] {
  const results: SearchMatch[] = [];
  // Per-file occurrence counter, keyed by the exact matched text (a
  // case-insensitive search can yield differently-cased matches).
  const occurrenceCounts = new Map<string, number>();

  for (const line of content.split("\n")) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const matchText = match[0];
      const occurrence = occurrenceCounts.get(matchText) ?? 0;
      occurrenceCounts.set(matchText, occurrence + 1);

      results.push({ filePath, matchText, lineText: line, occurrence });

      if (match.index === pattern.lastIndex) {
        pattern.lastIndex++;
      }
    }
  }

  return results;
}
