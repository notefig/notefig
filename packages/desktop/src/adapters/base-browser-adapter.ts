import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  IPlatformAdapter,
  PlatformEventListener,
  Result,
  SearchMatch,
  SearchOptions,
} from "./platform-adapter.interface";

export function createError(
  path: string,
  type: FileSystemError["type"],
  message: string,
): FileSystemError {
  return { path, type, message };
}

export function isHiddenPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) => part.startsWith(".") && part.length > 1);
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

export abstract class BaseBrowserAdapter implements IPlatformAdapter {
  abstract pickDirectory(title: string): Promise<string | null>;
  abstract readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
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
    const readResult = await this.readFiles([oldPath]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(oldPath, "not_found", "File not found"),
      };
    }
    const content = readResult.succeeded[0].content;
    const writeResult = await this.writeFiles([{ path: newPath, content }]);
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
    const readResult = await this.readFiles([from]);
    if (readResult.failed.length > 0 || readResult.succeeded.length === 0) {
      return {
        ok: false,
        error: createError(from, "not_found", "File not found"),
      };
    }
    const writeResult = await this.writeFiles([
      { path: to, content: readResult.succeeded[0].content },
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
