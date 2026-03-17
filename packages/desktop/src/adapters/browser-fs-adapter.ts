import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  IPlatformAdapter,
  PlatformEventListener,
  Result,
} from "./platform-adapter.interface";

type DirectoryHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;
type FsPermissionMode = "read" | "readwrite";

const WORKSPACE_PREFIX = "/fs/";
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

function createError(
  path: string,
  type: FileSystemError["type"],
  message: string,
): FileSystemError {
  return { path, type, message };
}

function isHiddenPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) => part.startsWith(".") && part.length > 1);
}

function getWorkspaceId(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "");
  const parts = trimmed.split("/");
  if (parts[0] !== "fs" || !parts[1]) return null;
  return parts[1];
}

function getWorkspacePrefix(workspaceId: string): string {
  return `${WORKSPACE_PREFIX}${workspaceId}`;
}

function getRelativePath(path: string, workspaceId: string): string {
  const prefix = getWorkspacePrefix(workspaceId);
  if (path === prefix) return "";
  if (path.startsWith(prefix + "/")) {
    return path.slice(prefix.length + 1);
  }
  return "";
}

async function ensurePermission(
  handle: DirectoryHandle | FileHandle,
  mode: FsPermissionMode,
): Promise<void> {
  const permissionHandle = handle as FileSystemHandle & {
    queryPermission?: (options: {
      mode: FsPermissionMode;
    }) => Promise<PermissionState>;
    requestPermission?: (options: {
      mode: FsPermissionMode;
    }) => Promise<PermissionState>;
  };

  if (
    !permissionHandle.queryPermission ||
    !permissionHandle.requestPermission
  ) {
    return; // Browser without permission APIs; assume ok
  }

  const state = await permissionHandle.queryPermission({ mode });
  if (state === "granted") return;
  const request = await permissionHandle.requestPermission({ mode });
  if (request !== "granted") {
    throw new Error("Permission denied");
  }
}

/**
 * Browser adapter backed by the File System Access API (Chromium-only).
 *
 * Fallback behavior:
 * - Disabled when __VITE_INDEXEDDB_NAME__ is set (E2E harness) to keep the
 *   IndexedDB-only adapter for tests.
 * - Disabled when showDirectoryPicker is missing; callers get the existing
 *   IndexedDB adapter instead.
 */
export class BrowserFsPlatformAdapter implements IPlatformAdapter {
  private handleCache = new Map<string, DirectoryHandle>();
  private db: IDBDatabase | null = null;

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
    id: string,
    handle: DirectoryHandle,
  ): Promise<void> {
    const db = await this.ensureDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([HANDLE_STORE_NAME], "readwrite");
      const store = tx.objectStore(HANDLE_STORE_NAME);
      store.put({ id, handle, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async loadHandle(id: string): Promise<DirectoryHandle | null> {
    if (this.handleCache.has(id)) {
      return this.handleCache.get(id)!;
    }

    const db = await this.ensureDB();
    return new Promise<DirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction([HANDLE_STORE_NAME], "readonly");
      const store = tx.objectStore(HANDLE_STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => {
        const result = request.result as
          | { handle?: DirectoryHandle }
          | undefined;
        if (result?.handle) {
          this.handleCache.set(id, result.handle);
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

  private async getRootHandle(basePath: string): Promise<DirectoryHandle> {
    const workspaceId = getWorkspaceId(basePath);
    if (!workspaceId) {
      throw new Error(`Invalid workspace path: ${basePath}`);
    }
    const existing = await this.loadHandle(workspaceId);
    if (!existing) {
      throw new Error("Workspace handle not found. Please re-open the folder.");
    }
    await ensurePermission(existing, "readwrite");
    return existing;
  }

  private async resolveDirectory(
    basePath: string,
    createMissing: boolean,
  ): Promise<DirectoryHandle> {
    const workspaceId = getWorkspaceId(basePath);
    if (!workspaceId) {
      throw new Error(`Invalid workspace path: ${basePath}`);
    }
    const rel = getRelativePath(basePath, workspaceId);
    const root = await this.getRootHandle(basePath);
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
    basePath: string,
    filePath: string,
    createDirs: boolean,
    createFile: boolean,
  ): Promise<{ handle: FileHandle; workspaceId: string }> {
    const workspaceId = getWorkspaceId(basePath);
    if (!workspaceId) {
      throw new Error(`Invalid workspace path: ${basePath}`);
    }
    const rel = getRelativePath(filePath, workspaceId);
    const segments = rel.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      throw new Error(`Invalid file path: ${filePath}`);
    }
    let dir = await this.getRootHandle(basePath);
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: createDirs });
    }
    const handle = await dir.getFileHandle(fileName, { create: createFile });
    return { handle, workspaceId };
  }

  private absolutePath(workspaceId: string, relPath: string): string {
    const prefix = getWorkspacePrefix(workspaceId);
    return relPath ? `${prefix}/${relPath}` : prefix;
  }

  async pickDirectory(title: string): Promise<string | null> {
    try {
      this.ensureSupported();
      // Title is not used by the API, but keep for parity
      void title;
      const handle = await (window as any).showDirectoryPicker();
      await ensurePermission(handle, "readwrite");
      const workspaceId = `fs-${crypto.randomUUID()}`;
      await this.storeHandle(workspaceId, handle);
      this.handleCache.set(workspaceId, handle);
      return getWorkspacePrefix(workspaceId);
    } catch (error) {
      console.error("[BrowserFsAdapter] pickDirectory failed", error);
      return null;
    }
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
      const workspaceId = getWorkspaceId(path);
      if (!workspaceId) {
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
              results.push(this.absolutePath(workspaceId, nextRel));
            }
          } else {
            if (includeDirectories) {
              results.push(this.absolutePath(workspaceId, nextRel));
            }
            if (recursive) {
              await walk(sub, nextRel);
            }
          }
        }
      };

      await walk(dir, getRelativePath(path, workspaceId));

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
        const workspaceId = getWorkspaceId(path);
        if (!workspaceId) throw new Error("Invalid workspace path");
        const rel = getRelativePath(path, workspaceId);
        const parentRel = rel.split("/").slice(0, -1).join("/");
        const dirName = rel.split("/").pop();
        if (!dirName) throw new Error("Invalid directory path");
        const parent = await this.resolveDirectory(
          this.absolutePath(workspaceId, parentRel),
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
      // Create target root
      await this.createDirectories([newPath]);
      // Copy files
      const filesResult = await this.readDirectory(oldPath, {
        recursive: true,
        includeFiles: true,
        includeDirectories: false,
      });
      if (filesResult.ok) {
        const filePaths = filesResult.value;
        const fileData = await this.readFiles(filePaths);
        await this.writeFiles(
          fileData.succeeded.map((f) => ({
            path: f.path.replace(oldPath, newPath),
            content: f.content,
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

  // ========== File Operations ==========
  async readFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>> {
    const succeeded: Array<{ path: string; content: string }> = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      try {
        const workspaceId = getWorkspaceId(path);
        if (!workspaceId) throw new Error("Invalid workspace path");
        const { handle } = await this.resolveFileHandle(
          getWorkspacePrefix(workspaceId),
          path,
          false,
          false,
        );
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

  async writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const file of files) {
      try {
        const workspaceId = getWorkspaceId(file.path);
        if (!workspaceId) throw new Error("Invalid workspace path");
        const { handle } = await this.resolveFileHandle(
          getWorkspacePrefix(workspaceId),
          file.path,
          true,
          true,
        );
        const writable = await handle.createWritable();
        await writable.write(file.content);
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

  async createFiles(paths: string[]): Promise<BatchResult<string>> {
    return this.writeFiles(paths.map((p) => ({ path: p, content: "" })));
  }

  async deleteFiles(paths: string[]): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const path of paths) {
      try {
        const workspaceId = getWorkspaceId(path);
        if (!workspaceId) throw new Error("Invalid workspace path");
        const rel = getRelativePath(path, workspaceId);
        const segments = rel.split("/").filter(Boolean);
        const fileName = segments.pop();
        if (!fileName) throw new Error("Invalid file path");
        const parentRel = segments.join("/");
        const parent = await this.resolveDirectory(
          this.absolutePath(workspaceId, parentRel),
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

  // ========== Metadata & Existence ==========
  async exists(
    paths: string[],
  ): Promise<{ path: string; exists: boolean; type?: "file" | "directory" }[]> {
    const results: {
      path: string;
      exists: boolean;
      type?: "file" | "directory";
    }[] = [];
    for (const path of paths) {
      const workspaceId = getWorkspaceId(path);
      if (!workspaceId) {
        results.push({ path, exists: false });
        continue;
      }
      const rel = getRelativePath(path, workspaceId);
      const segments = rel.split("/").filter(Boolean);
      const last = segments.pop();
      const parentRel = segments.join("/");
      try {
        if (!last) {
          await this.getRootHandle(path);
          results.push({ path, exists: true, type: "directory" });
          continue;
        }
        const parent = await this.resolveDirectory(
          this.absolutePath(workspaceId, parentRel),
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
      const workspaceId = getWorkspaceId(path);
      if (!workspaceId) {
        failed.push(
          createError(path, "invalid_path", "Invalid workspace path"),
        );
        continue;
      }
      const rel = getRelativePath(path, workspaceId);
      const segments = rel.split("/").filter(Boolean);
      const name = segments.pop();
      const parentRel = segments.join("/");
      try {
        if (!name) {
          await this.getRootHandle(path);
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
          this.absolutePath(workspaceId, parentRel),
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
          continue;
        } catch {
          // not a file, check directory
        }
        const dirHandle = await parent.getDirectoryHandle(name);
        // Directory metadata is limited; use current time placeholders
        const now = new Date();
        succeeded.push({
          path,
          type: "directory",
          size: 0,
          modifiedAt: now,
          createdAt: now,
        });
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

  // ========== File Watching ==========
  async startWatchingMetadata(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserFsAdapter] Metadata watching not yet implemented");
  }

  async startWatchingContent(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: implement polling + BroadcastChannel; no-op for now
    console.log("[BrowserFsAdapter] Content watching not yet implemented");
  }

  async stopWatching(_watchId: string): Promise<void> {
    // No-op
  }

  // ========== Event Listeners ==========
  addEventListener(_callback: PlatformEventListener): () => void {
    // No-op in browser
    return () => {};
  }

  removeEventListener(_callback: PlatformEventListener): void {
    // No-op in browser
  }

  // ========== App Settings ==========
  private readonly SETTINGS_PREFIX = "metrists-settings:";

  async getSetting<T>(key: string): Promise<T | undefined> {
    const raw = localStorage.getItem(this.SETTINGS_PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    localStorage.setItem(this.SETTINGS_PREFIX + key, JSON.stringify(value));
  }

  async getAllSettings(): Promise<Record<string, unknown>> {
    const settings: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(this.SETTINGS_PREFIX)) {
        const key = storageKey.slice(this.SETTINGS_PREFIX.length);
        const raw = localStorage.getItem(storageKey);
        if (raw !== null) {
          try {
            settings[key] = JSON.parse(raw);
          } catch {
            // skip malformed values
          }
        }
      }
    }
    return settings;
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  }
}

export function shouldUseBrowserFsAdapter(): boolean {
  if (isE2ETestEnv()) return false;
  if (isAutomatedBrowser()) return false;
  return supportsFsAccess();
}
