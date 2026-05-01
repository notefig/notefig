import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  Result,
  SearchMatch,
  SearchOptions,
  PlatformEventListener,
} from "./platform-adapter.interface";
import {
  BaseBrowserAdapter,
  createError,
  isHiddenPath,
  filterFilePaths,
  buildSearchPattern,
} from "./base-browser-adapter";
import {
  normalizeWorkspacePath,
  getWorkspaceRoot,
  getRelativePath,
  ensurePermission,
  buildAbsolutePath,
} from "./browser-fs-utils";
import { BrowserFileWatcher } from "./browser-file-watcher";
import { calculateContentHash } from "@/utils/hash";
import { processPool } from "@/utils/process-pool";

type DirectoryHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

const HANDLE_STORE_NAME = "fs-handles";
const HANDLE_DB_VERSION = 1;

function isE2ETestEnv(): boolean {
  return Boolean((window as any).__VITE_INDEXEDDB_NAME__);
}

function isAutomatedBrowser(): boolean {
  return (
    typeof navigator !== "undefined" && (navigator as any).webdriver === true
  );
}

function supportsFsAccess(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export class BrowserFsPlatformAdapter extends BaseBrowserAdapter {
  private handleCache = new Map<string, DirectoryHandle>();
  private db: IDBDatabase | null = null;
  private fileWatcher: BrowserFileWatcher;

  constructor() {
    super();
    // Initialize file watcher with bound methods
    this.fileWatcher = new BrowserFileWatcher(
      this.readDirectory.bind(this),
      this.readFiles.bind(this),
      this.getMetadata.bind(this),
    );
  }

  private async ensureDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open("metrists-fs-handles", HANDLE_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
          db.createObjectStore(HANDLE_STORE_NAME, { keyPath: "id" });
        }
      };
    });
  }

  private async storeHandle(
    workspacePath: string,
    handle: DirectoryHandle,
  ): Promise<void> {
    const db = await this.ensureDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([HANDLE_STORE_NAME], "readwrite");
      const store = tx.objectStore(HANDLE_STORE_NAME);
      store.put({ id: workspacePath, handle, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async loadHandle(
    workspacePath: string,
  ): Promise<DirectoryHandle | null> {
    if (this.handleCache.has(workspacePath)) {
      return this.handleCache.get(workspacePath)!;
    }

    const db = await this.ensureDB();
    return new Promise<DirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction([HANDLE_STORE_NAME], "readonly");
      const store = tx.objectStore(HANDLE_STORE_NAME);
      const request = store.get(workspacePath);
      request.onsuccess = () => {
        const result = request.result as
          | { handle?: DirectoryHandle }
          | undefined;
        if (result?.handle) {
          this.handleCache.set(workspacePath, result.handle);
          resolve(result.handle);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  private ensureSupported(): void {
    if (!supportsFsAccess()) {
      throw new Error("File System Access API not supported in this browser");
    }
  }

  private async getRootHandle(workspacePath: string): Promise<DirectoryHandle> {
    const existing = await this.loadHandle(workspacePath);
    if (!existing) {
      throw new Error(
        `Workspace handle not found for ${workspacePath}. Please re-open the folder.`,
      );
    }
    await ensurePermission(existing, "readwrite");
    return existing;
  }

  private async resolveDirectory(
    path: string,
    createMissing: boolean,
  ): Promise<DirectoryHandle> {
    const workspaceRoot = getWorkspaceRoot(path);
    if (!workspaceRoot) {
      throw new Error(`Invalid workspace path: ${path}`);
    }

    const rel = getRelativePath(path, workspaceRoot);
    const root = await this.getRootHandle(workspaceRoot);
    if (!rel) return root;

    const parts = rel.split("/").filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, {
        create: createMissing,
      });
    }
    return current;
  }

  private async resolveFileHandle(
    filePath: string,
    createDirs: boolean,
    createFile: boolean,
  ): Promise<FileHandle> {
    const workspaceRoot = getWorkspaceRoot(filePath);
    if (!workspaceRoot) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    const rel = getRelativePath(filePath, workspaceRoot);
    const segments = rel.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    let dir = await this.getRootHandle(workspaceRoot);
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: createDirs });
    }
    return await dir.getFileHandle(fileName, { create: createFile });
  }

  async pickDirectory(title: string): Promise<string | null> {
    try {
      this.ensureSupported();
      void title;

      const handle = await (window as any).showDirectoryPicker();
      await ensurePermission(handle, "readwrite");

      const workspacePath = normalizeWorkspacePath(handle.name);

      // Store the handle indexed by the workspace path
      await this.storeHandle(workspacePath, handle);
      this.handleCache.set(workspacePath, handle);

      return workspacePath;
    } catch (error) {
      return null;
    }
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
      const workspaceRoot = getWorkspaceRoot(path);
      if (!workspaceRoot) {
        throw new Error("Invalid workspace path");
      }

      const dir = await this.resolveDirectory(path, false);
      const includeFiles = options?.includeFiles !== false;
      const includeDirectories = options?.includeDirectories !== false;
      const recursive = options?.recursive ?? false;

      const results: string[] = [];

      const walk = async (
        handle: DirectoryHandle,
        currentRel: string,
      ): Promise<void> => {
        const iterator = (handle as any).entries?.() ?? [];
        for await (const entry of iterator as AsyncIterable<[string, any]>) {
          const [name, sub] = entry;
          if (isHiddenPath(name)) continue;
          const nextRel = currentRel ? `${currentRel}/${name}` : name;
          if (sub.kind === "file") {
            if (includeFiles) {
              results.push(buildAbsolutePath(workspaceRoot, nextRel));
            }
          } else {
            if (includeDirectories) {
              results.push(buildAbsolutePath(workspaceRoot, nextRel));
            }
            if (recursive) {
              await walk(sub, nextRel);
            }
          }
        }
      };

      await walk(dir, getRelativePath(path, workspaceRoot));

      return { ok: true, value: results };
    } catch (error) {
      return {
        ok: false,
        error: createError(
          path,
          "io_error",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async createDirectories(paths: string[]): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];
    for (const path of paths) {
      try {
        await this.resolveDirectory(path, true);
        succeeded.push(path);
      } catch (error) {
        failed.push(
          createError(
            path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }
    return { succeeded, failed };
  }

  async deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];
    for (const path of paths) {
      try {
        const workspaceRoot = getWorkspaceRoot(path);
        if (!workspaceRoot) throw new Error("Invalid workspace path");

        const rel = getRelativePath(path, workspaceRoot);
        const parentRel = rel.split("/").slice(0, -1).join("/");
        const dirName = rel.split("/").pop();
        if (!dirName) throw new Error("Invalid directory path");

        const parent = await this.resolveDirectory(
          buildAbsolutePath(workspaceRoot, parentRel),
          false,
        );
        await parent.removeEntry(dirName, {
          recursive: options?.recursive ?? false,
        });
        succeeded.push(path);
      } catch (error) {
        failed.push(
          createError(
            path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }
    return { succeeded, failed };
  }

  async moveDirectory(oldPath: string, newPath: string): Promise<Result<void>> {
    try {
      await this.createDirectories([newPath]);
      const filesResult = await this.readDirectory(oldPath, {
        recursive: true,
        includeFiles: true,
        includeDirectories: false,
      });
      if (filesResult.ok) {
        const filePaths = filesResult.value;
        const fileData = await this.readBinaryFiles(filePaths);
        await this.writeBinaryFiles(
          fileData.succeeded.map((f) => ({
            path: f.path.replace(oldPath, newPath),
            data: f.data,
          })),
        );
      }
      await this.deleteDirectories([oldPath], { recursive: true });
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: createError(
          oldPath,
          "io_error",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>> {
    const succeeded: Array<{ path: string; content: string }> = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      try {
        const handle = await this.resolveFileHandle(path, false, false);
        const file = await handle.getFile();
        const content = await file.text();
        succeeded.push({ path, content });
      } catch (error) {
        failed.push(
          createError(
            path,
            "not_found",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>> {
    const succeeded: Array<{ path: string; data: Uint8Array }> = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      try {
        const handle = await this.resolveFileHandle(path, false, false);
        const file = await handle.getFile();
        const buffer = await file.arrayBuffer();
        succeeded.push({ path, data: new Uint8Array(buffer) });
      } catch (error) {
        failed.push(
          createError(
            path,
            "not_found",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const file of files) {
      try {
        // Read current content to get the old hash BEFORE writing
        // This prevents race condition where watcher polls during write and reads stale content
        let oldContentHash: string | undefined;
        try {
          const handle = await this.resolveFileHandle(file.path, false, false);
          const fileObj = await handle.getFile();
          const oldContent = await fileObj.text();
          oldContentHash = calculateContentHash(oldContent);
        } catch {
          // File doesn't exist yet - no old hash to register
        }

        const handle = await this.resolveFileHandle(file.path, true, true);
        const writable = await handle.createWritable();
        await writable.write(file.content);
        await writable.close();

        const newContentHash = calculateContentHash(file.content);

        // Register BOTH old and new hashes as app writes:
        // - Old hash: prevents watcher from emitting stale content if it polls during write
        // - New hash: prevents watcher from emitting the new content as external change
        if (oldContentHash) {
          this.fileWatcher.registerAppWrite(file.path, oldContentHash);
        }
        this.fileWatcher.registerAppWrite(file.path, newContentHash);

        succeeded.push(file.path);
      } catch (error) {
        failed.push(
          createError(
            file.path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async deleteFiles(paths: string[]): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      try {
        const workspaceRoot = getWorkspaceRoot(path);
        if (!workspaceRoot) throw new Error("Invalid workspace path");

        const rel = getRelativePath(path, workspaceRoot);
        const segments = rel.split("/").filter(Boolean);
        const fileName = segments.pop();
        if (!fileName) throw new Error("Invalid file path");

        const parentRel = segments.join("/");
        const parent = await this.resolveDirectory(
          buildAbsolutePath(workspaceRoot, parentRel),
          false,
        );
        await parent.removeEntry(fileName);
        succeeded.push(path);
      } catch (error) {
        failed.push(
          createError(
            path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]> {
    const results: {
      path: string;
      exists: boolean;
      type?: "file" | "directory";
    }[] = [];

    for (const path of paths) {
      const workspaceRoot = getWorkspaceRoot(path);
      if (!workspaceRoot) {
        results.push({ path, exists: false });
        continue;
      }

      const rel = getRelativePath(path, workspaceRoot);
      const segments = rel.split("/").filter(Boolean);
      const last = segments.pop();
      const parentRel = segments.join("/");

      try {
        if (!last) {
          // This is the root workspace directory
          await this.getRootHandle(workspaceRoot);
          results.push({ path, exists: true, type: "directory" });
          continue;
        }

        const parent = await this.resolveDirectory(
          buildAbsolutePath(workspaceRoot, parentRel),
          false,
        );

        try {
          await parent.getFileHandle(last);
          results.push({ path, exists: true, type: "file" });
        } catch {
          try {
            await parent.getDirectoryHandle(last);
            results.push({ path, exists: true, type: "directory" });
          } catch {
            results.push({ path, exists: false });
          }
        }
      } catch {
        results.push({ path, exists: false });
      }
    }

    return results;
  }

  async getMetadata(paths: string[]): Promise<BatchResult<FileSystemMetadata>> {
    const succeeded: FileSystemMetadata[] = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      const workspaceRoot = getWorkspaceRoot(path);
      if (!workspaceRoot) {
        failed.push(
          createError(path, "invalid_path", "Invalid workspace path"),
        );
        continue;
      }

      const rel = getRelativePath(path, workspaceRoot);
      const segments = rel.split("/").filter(Boolean);
      const name = segments.pop();
      const parentRel = segments.join("/");

      try {
        if (!name) {
          // Root directory
          await this.getRootHandle(workspaceRoot);
          const now = new Date();
          succeeded.push({
            path,
            type: "directory",
            size: 0,
            modifiedAt: now,
            createdAt: now,
          });
          continue;
        }

        const parent = await this.resolveDirectory(
          buildAbsolutePath(workspaceRoot, parentRel),
          false,
        );

        try {
          const fileHandle = await parent.getFileHandle(name);
          const file = await fileHandle.getFile();
          succeeded.push({
            path,
            type: "file",
            size: file.size,
            modifiedAt: new Date(file.lastModified),
            createdAt: new Date(file.lastModified),
          });
        } catch {
          const dirHandle = await parent.getDirectoryHandle(name);
          const now = new Date();
          succeeded.push({
            path,
            type: "directory",
            size: 0,
            modifiedAt: now,
            createdAt: now,
          });
        }
      } catch (error) {
        failed.push(
          createError(
            path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const file of files) {
      const workspaceRoot = getWorkspaceRoot(file.path);
      if (!workspaceRoot) {
        failed.push(
          createError(file.path, "invalid_path", "Invalid workspace path"),
        );
        continue;
      }

      try {
        const parentPath = file.path.substring(0, file.path.lastIndexOf("/"));
        const parentHandle = await this.resolveDirectory(parentPath, true);
        const fileName = file.path.split("/").pop() || "";

        const fileHandle = await parentHandle.getFileHandle(fileName, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(file.data as BufferSource);
        await writable.close();

        succeeded.push(file.path);
      } catch (error) {
        failed.push(
          createError(
            file.path,
            "io_error",
            error instanceof Error ? error.message : "Unknown error",
          ),
        );
      }
    }

    return { succeeded, failed };
  }

  async resolveAssetUrl(
    relativePath: string,
    workspacePath: string,
  ): Promise<string> {
    // If path is already absolute, use it directly; otherwise join with workspace
    const absolutePath = relativePath.startsWith("/")
      ? relativePath
      : `${workspacePath}/${relativePath}`.replace(/\/+/g, "/");

    try {
      const fileHandle = await this.resolveFileHandle(
        absolutePath,
        false,
        false,
      );
      const file = await fileHandle.getFile();
      return URL.createObjectURL(file);
    } catch {
      return relativePath;
    }
  }

  async startWatchingMetadata(paths: string[], watchId: string): Promise<void> {
    await this.fileWatcher.startWatchingMetadata(paths, watchId);
  }

  async startWatchingContent(paths: string[], watchId: string): Promise<void> {
    await this.fileWatcher.startWatchingContent(paths, watchId);
  }

  async stopWatching(watchId: string): Promise<void> {
    this.fileWatcher.stopWatching(watchId);
  }

  addEventListener(callback: PlatformEventListener): () => void {
    return this.fileWatcher.addEventListener(callback);
  }

  removeEventListener(callback: PlatformEventListener): void {
    this.fileWatcher.removeEventListener(callback);
  }

  /**
   * Override searchContent to use streaming — file contents are never
   * fully materialized in memory. Uses file.stream() → searchStream().
   */
  async searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]> {
    const maxResults = options.maxResults ?? 1000;

    let filePaths: string[];

    if (options.fileIncludes?.length) {
      // Skip directory walk — use provided paths directly
      filePaths = filterFilePaths(options.fileIncludes, options);
    } else {
      const dirResult = await this.readDirectory(directory, {
        recursive: true,
        includeFiles: true,
        includeDirectories: false,
      });

      if (!dirResult.ok) {
        return [];
      }

      filePaths = filterFilePaths(dirResult.value, options);
    }

    const pattern = buildSearchPattern(options);
    if (!pattern) return [];

    const { succeeded } = await processPool(
      filePaths,
      async (filePath: string) => {
        try {
          const handle = await this.resolveFileHandle(filePath, false, false);
          const file = await handle.getFile();
          const stream = file.stream() as ReadableStream<Uint8Array>;
          // Create a fresh regex per worker to avoid shared lastIndex state
          const workerPattern = new RegExp(pattern.source, pattern.flags);
          return await searchStream(
            stream,
            filePath,
            workerPattern,
            maxResults,
          );
        } catch {
          return []; // Skip files with permission/access errors
        }
      },
      {
        concurrency: 6,
        shouldContinue: (r) => r.length < maxResults,
      },
    );

    return succeeded.slice(0, maxResults);
  }
}

export function shouldUseBrowserFsAdapter(): boolean {
  if (isE2ETestEnv()) return false;
  if (isAutomatedBrowser()) return false;
  return supportsFsAccess();
}

/**
 * Line-by-line streaming search over a ReadableStream<Uint8Array>.
 *
 * Reads chunks via getReader(), splits by newline, searches complete lines,
 * carries the incomplete tail to the next chunk. Returns early (cancels reader)
 * once maxResults is hit.
 *
 * Peak memory per file ≈ one chunk (~64KB) + the current line buffer.
 */
export async function searchStream(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  pattern: RegExp,
  maxResults?: number,
): Promise<SearchMatch[]> {
  const results: SearchMatch[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let lineNumber = 0;
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer.length > 0) {
          lineNumber++;
          searchLine(buffer, filePath, pattern, lineNumber, results);
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        lineNumber++;
        searchLine(line, filePath, pattern, lineNumber, results);

        if (maxResults !== undefined && results.length >= maxResults) {
          await reader.cancel();
          return results;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return results;
}

function searchLine(
  line: string,
  filePath: string,
  pattern: RegExp,
  lineNumber: number,
  results: SearchMatch[],
): void {
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    results.push({
      location: {
        filePath,
        range: {
          start: { line: lineNumber, column: match.index + 1 },
          end: {
            line: lineNumber,
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
