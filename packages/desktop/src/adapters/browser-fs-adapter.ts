import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  Result,
} from "./platform-adapter.interface";
import {
  BaseBrowserAdapter,
  createError,
  isHiddenPath,
} from "./base-browser-adapter";
import {
  normalizeWorkspacePath,
  getWorkspaceRoot,
  getRelativePath,
  ensurePermission,
  buildAbsolutePath,
} from "./browser-fs-utils";

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
      console.error("[BrowserFsAdapter] pickDirectory failed", error);
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

  async writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    for (const file of files) {
      try {
        const handle = await this.resolveFileHandle(file.path, true, true);
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
}

export function shouldUseBrowserFsAdapter(): boolean {
  if (isE2ETestEnv()) return false;
  if (isAutomatedBrowser()) return false;
  return supportsFsAccess();
}
