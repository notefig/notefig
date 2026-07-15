import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  IPlatformAdapter,
  PlatformUpdater,
  PlatformEventListener,
  Result,
  SearchMatch,
  SearchOptions,
  TextPromptOptions,
} from "./platform-adapter.interface";
import { requestTextPrompt } from "@/utils/text-prompt";
import type { GitStorageHost } from "@metrists/git";
import type { AgentTransport, McpEndpoint } from "@/agent/agent-transport.interface";

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

const UPDATER_MANIFEST_URL =
  "https://app.metrists.com/latest.json";

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
  private gitLocks = new Set<string>();

  abstract pickDirectory(title: string): Promise<string | null>;

  // The pure-IndexedDB adapter has no permission surface; the FS Access
  // adapter overrides this.
  async requestWorkspaceAccess(_workspacePath: string): Promise<boolean> {
    return true;
  }

  async promptText(options: TextPromptOptions): Promise<string | null> {
    // Same in-app dialog on the web — consistent UX, no native prompt.
    return requestTextPrompt(options);
  }

  openExternal(url: string): Promise<void> {
    // Only allow http, https, and mailto schemes
    const allowed = /^(https?|mailto):/i;
    if (allowed.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    return Promise.resolve();
  }
  abstract readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
      includeHidden?: boolean;
    },
  ): Promise<Result<string[]>>;
  abstract createDirectories(paths: string[]): Promise<BatchResult<string>>;
  abstract deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>>;
  abstract moveDirectory(
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>>;
  abstract readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>>;
  abstract readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>>;
  abstract writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>>;
  abstract deleteFiles(paths: string[]): Promise<BatchResult<string>>;
  abstract writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>>;
  abstract resolveAssetUrl(
    relativePath: string,
    workspacePath: string,
  ): Promise<string>;
  abstract exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]>;
  abstract getMetadata(
    paths: string[],
  ): Promise<BatchResult<FileSystemMetadata>>;

  async createFiles(paths: string[]): Promise<BatchResult<string>> {
    return this.writeFiles(paths.map((path) => ({ path, content: "" })));
  }

  async moveFile(oldPath: string, newPath: string): Promise<Result<void>> {
    const readResult = await this.readBinaryFiles([oldPath]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(oldPath, "not_found", "File not found"),
      };
    }
    const data = readResult.succeeded[0].data;
    const writeResult = await this.writeBinaryFiles([{ path: newPath, data }]);
    if (writeResult.failed.length > 0) {
      return {
        ok: false,
        error: writeResult.failed[0],
      };
    }
    await this.deleteFiles([oldPath]);
    return { ok: true, value: undefined };
  }

  async copyFile(from: string, to: string): Promise<Result<void>> {
    const readResult = await this.readBinaryFiles([from]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(from, "not_found", "File not found"),
      };
    }
    const writeResult = await this.writeBinaryFiles([
      { path: to, data: readResult.succeeded[0].data },
    ]);
    if (writeResult.failed.length > 0) {
      return { ok: false, error: writeResult.failed[0] };
    }
    return { ok: true, value: undefined };
  }

  async startWatchingMetadata(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: Implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserAdapter] Metadata watching not yet implemented");
  }

  async startWatchingContent(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: Implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserAdapter] Content watching not yet implemented");
  }

  async stopWatching(_watchId: string): Promise<void> {
    // No-op
  }

  addEventListener(_callback: PlatformEventListener): () => void {
    // No-op in browser - return empty cleanup function
    return () => {};
  }

  removeEventListener(_callback: PlatformEventListener): void {
    // No-op in browser
  }

  private readonly KV_PREFIX = "metrists-kv:";

  private buildKvKey(namespace: string, key: string): string {
    return `${this.KV_PREFIX}${namespace}:${key}`;
  }

  async getKv<T>(namespace: string, key: string): Promise<T | undefined> {
    const raw = localStorage.getItem(this.buildKvKey(namespace, key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async setKv<T>(namespace: string, key: string, value: T): Promise<void> {
    localStorage.setItem(
      this.buildKvKey(namespace, key),
      JSON.stringify(value),
    );
  }

  async deleteKv(namespace: string, key: string): Promise<void> {
    localStorage.removeItem(this.buildKvKey(namespace, key));
  }

  async getAllKv<T>(namespace: string): Promise<Record<string, T>> {
    const prefix = `${this.KV_PREFIX}${namespace}:`;
    const result: Record<string, T> = {};

    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(prefix)) {
        const key = storageKey.slice(prefix.length);
        const raw = localStorage.getItem(storageKey);
        if (raw !== null) {
          try {
            result[key] = JSON.parse(raw) as T;
          } catch {
            // skip malformed values
          }
        }
      }
    }
    return result;
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  }

  abstract searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]>;

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
        const mapped = childExists
          .filter((entry) => entry.exists)
          .map((entry) => ({
            name: entry.path.split("/").filter(Boolean).pop() ?? entry.path,
            isFile: entry.type === "file",
            isDir: entry.type === "directory",
            isSymbolicLink: false,
          }));
        return mapped;
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

  createAgentTransport(): AgentTransport {
    // Relay transport lands with Phase 3 web parity; the seam exists now so
    // the agent service never constructs a transport itself.
    throw new Error("Agent transport is not supported on this adapter yet.");
  }

  createMcpEndpoint(): McpEndpoint {
    // Same Phase 3 web-parity gap as createAgentTransport: a remote harness
    // can't reach a desktop loopback relay; the seam exists now so the agent
    // service never constructs an endpoint itself.
    throw new Error("MCP endpoint is not supported on this adapter yet.");
  }

  async runShellCommand(
    _script: string,
  ): Promise<{ stdout: string; exitCode: number }> {
    // Not a future-parity gap like the two above — running arbitrary local
    // shell scripts from a browser sandbox is categorically impossible.
    // Callers (harness-discovery.ts) treat this rejection the same as "found
    // nothing locally".
    throw new Error("Shell commands are not supported on this adapter.");
  }

  getUpdater(): PlatformUpdater {
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

  // If fileIncludes is set, only search those files
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

/**
 * Search a file's content string for pattern matches.
 */
export function searchFileContent(
  filePath: string,
  content: string,
  pattern: RegExp,
): SearchMatch[] {
  const results: SearchMatch[] = [];
  const lines = content.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      results.push({
        location: {
          filePath,
          range: {
            start: { line: lineIdx + 1, column: match.index + 1 },
            end: {
              line: lineIdx + 1,
              column: match.index + match[0].length + 1,
            },
          },
        },
        content: {
          matchText: match[0],
          lineContent: line,
          beforeContext: [],
          afterContext: [],
        },
      });

      if (match.index === pattern.lastIndex) {
        pattern.lastIndex++;
      }
    }
  }

  return results;
}
