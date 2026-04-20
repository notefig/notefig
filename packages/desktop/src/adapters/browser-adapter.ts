import type {
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  SearchMatch,
  SearchOptions,
} from "./platform-adapter.interface";
import {
  BaseBrowserAdapter,
  isHiddenPath,
  createError,
  filterFilePaths,
  buildSearchPattern,
  searchFileContent,
} from "./base-browser-adapter";
import { processPool } from "@/utils/process-pool";

export class BrowserPlatformAdapter extends BaseBrowserAdapter {
  private db: IDBDatabase | null = null;
  private readonly DB_VERSION = 1;
  private readonly STORE_NAME = "files";

  private getDBName(): string {
    const testOverride = (window as any).__VITE_INDEXEDDB_NAME__;
    if (testOverride) {
      return testOverride;
    }
    return "metrists-fs";
  }

  private async ensureDB(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    const dbName = this.getDBName();

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, this.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        console.log("[BrowserAdapter] Opened database:", dbName);
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: "path" });
        }
      };
    });
  }

  private async isDirectory(db: IDBDatabase, path: string): Promise<boolean> {
    const transaction = db.transaction([this.STORE_NAME], "readonly");
    const store = transaction.objectStore(this.STORE_NAME);

    const allKeys: string[] = await new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });

    const normalizedPath = path.endsWith("/") ? path : path + "/";

    return allKeys.some(
      (key) => key.startsWith(normalizedPath) && key !== normalizedPath,
    );
  }

  private async getDirectories(
    db: IDBDatabase,
    basePath: string,
    recursive: boolean,
  ): Promise<string[]> {
    const transaction = db.transaction([this.STORE_NAME], "readonly");
    const store = transaction.objectStore(this.STORE_NAME);

    const allKeys: string[] = await new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });

    const normalizedPath = basePath.endsWith("/") ? basePath : basePath + "/";
    const directories = new Set<string>();

    for (const key of allKeys) {
      if (!key.startsWith(normalizedPath)) continue;

      const relativePath = key.slice(normalizedPath.length);
      if (!relativePath) continue;

      const pathParts = relativePath.split("/");

      if (recursive) {
        // Add all parent directories
        let currentPath = normalizedPath;
        for (let i = 0; i < pathParts.length - 1; i++) {
          currentPath += pathParts[i] + "/";
          const dirPath = currentPath.slice(0, -1);
          if (!isHiddenPath(dirPath)) {
            directories.add(dirPath);
          }
        }
      } else {
        // Only add direct child directories
        if (pathParts.length > 1) {
          const dirPath = normalizedPath + pathParts[0];
          if (!isHiddenPath(dirPath)) {
            directories.add(dirPath);
          }
        }
      }
    }

    return Array.from(directories);
  }

  async pickDirectory(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      const event = new CustomEvent("mock-pick-directory", {
        detail: {
          title,
          callback: async (path: string | null) => {
            if (path) {
              if (path === "/workspace/demo-content") {
                await this.seedDemoData(path);
              }
            }
            resolve(path);
          },
        },
      });
      window.dispatchEvent(event);
    });
  }

  private async seedDemoData(basePath: string): Promise<void> {
    try {
      const db = await this.ensureDB();

      // Check if demo data already exists
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      const allKeys: string[] = await new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });

      const normalizedPath = basePath.endsWith("/") ? basePath : basePath + "/";
      const existingFiles = allKeys.filter((key) =>
        key.startsWith(normalizedPath),
      );

      if (existingFiles.length > 0) {
        console.log("[BrowserAdapter] Demo data already exists, skipping seed");
        return;
      }

      console.log("[BrowserAdapter] Seeding demo data for", basePath);

      const { generateDemoFiles } = await import("@/utils/demo-data");
      const demoFiles = generateDemoFiles(basePath);

      const writeTransaction = db.transaction([this.STORE_NAME], "readwrite");
      const writeStore = writeTransaction.objectStore(this.STORE_NAME);

      for (const file of Object.values(demoFiles)) {
        writeStore.put({
          path: file.path,
          content: file.content || "",
          modifiedAt: new Date(file.modified || Date.now()),
          createdAt: new Date(file.modified || Date.now()),
        });
      }

      await new Promise<void>((resolve, reject) => {
        writeTransaction.oncomplete = () => {
          console.log(
            "[BrowserAdapter] Demo data seeded successfully:",
            Object.keys(demoFiles).length,
            "files",
          );
          resolve();
        };
        writeTransaction.onerror = () => reject(writeTransaction.error);
      });
    } catch (error) {
      console.error("[BrowserAdapter] Failed to seed demo data:", error);
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
      const db = await this.ensureDB();

      if (
        path === "/workspace/demo-content" ||
        path.startsWith("/workspace/demo-content/")
      ) {
        const checkTransaction = db.transaction([this.STORE_NAME], "readonly");
        const checkStore = checkTransaction.objectStore(this.STORE_NAME);
        const count = await new Promise<number>((resolve, reject) => {
          const request = checkStore.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        if (count === 0) {
          await this.seedDemoData("/workspace/demo-content");
        }
      }

      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      const allKeys: string[] = await new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });

      const includeFiles = options?.includeFiles !== false;
      const includeDirectories = options?.includeDirectories !== false;
      const recursive = options?.recursive ?? false;

      const normalizedPath = path.endsWith("/") ? path : path + "/";

      const results: string[] = [];

      if (includeFiles) {
        const filePaths = allKeys.filter((key) => {
          if (!key.startsWith(normalizedPath)) return false;

          if (isHiddenPath(key)) return false;

          const relativePath = key.slice(normalizedPath.length);

          if (!recursive && relativePath.includes("/")) return false;

          return true;
        });
        results.push(...filePaths);
      }

      if (includeDirectories) {
        const directoryPaths = await this.getDirectories(db, path, recursive);
        results.push(...directoryPaths);
      }

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
    return { succeeded: paths, failed: [] };
  }

  async deleteDirectories(
    paths: string[],
    options?: { recursive?: boolean },
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    if (paths.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();

      for (const path of paths) {
        try {
          const normalizedPath = path.endsWith("/") ? path : path + "/";

          const transaction = db.transaction([this.STORE_NAME], "readwrite");
          const store = transaction.objectStore(this.STORE_NAME);

          const allKeys: string[] = await new Promise((resolve, reject) => {
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result as string[]);
            request.onerror = () => reject(request.error);
          });

          const keysToDelete = allKeys.filter((key) =>
            key.startsWith(normalizedPath),
          );

          if (keysToDelete.length > 0 && !options?.recursive) {
            failed.push(createError(path, "not_empty", "Directory not empty"));
            continue;
          }

          const deleteTransaction = db.transaction(
            [this.STORE_NAME],
            "readwrite",
          );
          const deleteStore = deleteTransaction.objectStore(this.STORE_NAME);

          for (const key of keysToDelete) {
            deleteStore.delete(key);
          }

          await new Promise<void>((resolve, reject) => {
            deleteTransaction.oncomplete = () => resolve();
            deleteTransaction.onerror = () => reject(deleteTransaction.error);
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
    } catch (error) {
      paths.forEach((path) => {
        if (!succeeded.includes(path)) {
          failed.push(
            createError(
              path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
    }

    return { succeeded, failed };
  }

  async moveDirectory(oldPath: string, newPath: string): Promise<Result<void>> {
    try {
      const db = await this.ensureDB();
      const normalizedOldPath = oldPath.endsWith("/") ? oldPath : oldPath + "/";
      const normalizedNewPath = newPath.endsWith("/") ? newPath : newPath + "/";

      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      const allKeys: string[] = await new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });

      const filesToMove = allKeys.filter((key) =>
        key.startsWith(normalizedOldPath),
      );

      const readTransaction = db.transaction([this.STORE_NAME], "readonly");
      const readStore = readTransaction.objectStore(this.STORE_NAME);
      const fileData: Array<{ path: string; content: string }> = [];

      for (const filePath of filesToMove) {
        const data: any = await new Promise((resolve, reject) => {
          const request = readStore.get(filePath);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        fileData.push(data);
      }

      const writeTransaction = db.transaction([this.STORE_NAME], "readwrite");
      const writeStore = writeTransaction.objectStore(this.STORE_NAME);

      for (const file of fileData) {
        const newFilePath = file.path.replace(
          normalizedOldPath,
          normalizedNewPath,
        );
        writeStore.put({ ...file, path: newFilePath });
        writeStore.delete(file.path);
      }

      await new Promise<void>((resolve, reject) => {
        writeTransaction.oncomplete = () => resolve();
        writeTransaction.onerror = () => reject(writeTransaction.error);
      });

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

    if (paths.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const path of paths) {
        try {
          const data: any = await new Promise((resolve, reject) => {
            const request = store.get(path);
            request.onsuccess = () => {
              if (request.result) {
                resolve(request.result);
              } else {
                reject(new Error("File not found"));
              }
            };
            request.onerror = () => reject(request.error);
          });

          succeeded.push({ path, content: data.content || "" });
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
    } catch (error) {
      paths.forEach((path) => {
        if (!succeeded.find((s) => s.path === path)) {
          failed.push(
            createError(
              path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
    }

    return { succeeded, failed };
  }

  async writeFiles(
    files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    if (files.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const file of files) {
        try {
          await new Promise<void>((resolve, reject) => {
            const request = store.put({
              path: file.path,
              content: file.content,
              modifiedAt: new Date(),
              createdAt: new Date(),
            });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });

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
    } catch (error) {
      // DB-level error - fail all
      files.forEach((file) => {
        if (!succeeded.includes(file.path)) {
          failed.push(
            createError(
              file.path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
    }

    return { succeeded, failed };
  }

  async writeBinaryFiles(
    files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    if (files.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const file of files) {
        try {
          const base64 = this.uint8ArrayToBase64(file.data);

          await new Promise<void>((resolve, reject) => {
            const request = store.put({
              path: file.path,
              content: "", // No text content for binary files
              binaryData: base64,
              mimeType: this.guessMimeType(file.path),
              modifiedAt: new Date(),
              createdAt: new Date(),
            });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });

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
    } catch (error) {
      files.forEach((file) => {
        if (!succeeded.includes(file.path)) {
          failed.push(
            createError(
              file.path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
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
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      const result: {
        binaryData?: string;
        mimeType?: string;
      } | null = await new Promise((resolve, reject) => {
        const request = store.get(absolutePath);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });

      if (result && result.binaryData) {
        const binaryString = atob(result.binaryData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], {
          type: result.mimeType || "image/png",
        });
        return URL.createObjectURL(blob);
      }

      // Fallback: return relative path (won't display but won't crash)
      return relativePath;
    } catch {
      return relativePath;
    }
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private guessMimeType(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const mimeTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      flac: "audio/flac",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  async deleteFiles(paths: string[]): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    const failed: FileSystemError[] = [];

    if (paths.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const path of paths) {
        try {
          await new Promise<void>((resolve, reject) => {
            const request = store.delete(path);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
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
    } catch (error) {
      // DB-level error - fail all
      paths.forEach((path) => {
        if (!succeeded.includes(path)) {
          failed.push(
            createError(
              path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
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

    if (paths.length === 0) {
      return results;
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const path of paths) {
        try {
          // Check if it exists as a file in IndexedDB
          const fileExists = await new Promise<boolean>((resolve) => {
            const request = store.get(path);
            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => resolve(false);
          });

          if (fileExists) {
            results.push({ path, exists: true, type: "file" });
          } else {
            // Check if it exists as a directory (has children)
            const isDir = await this.isDirectory(db, path);
            if (isDir) {
              results.push({ path, exists: true, type: "directory" });
            } else {
              results.push({ path, exists: false });
            }
          }
        } catch {
          results.push({ path, exists: false });
        }
      }
    } catch {
      // DB error - mark all as non-existent
      paths.forEach((path) => {
        results.push({ path, exists: false });
      });
    }

    return results;
  }

  async getMetadata(paths: string[]): Promise<BatchResult<FileSystemMetadata>> {
    const succeeded: FileSystemMetadata[] = [];
    const failed: FileSystemError[] = [];

    if (paths.length === 0) {
      return { succeeded, failed };
    }

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const path of paths) {
        try {
          // Try to get as file first
          const data: any = await new Promise((resolve, reject) => {
            const request = store.get(path);
            request.onsuccess = () => {
              if (request.result) {
                resolve(request.result);
              } else {
                resolve(null);
              }
            };
            request.onerror = () => reject(request.error);
          });

          if (data) {
            // It's a file
            succeeded.push({
              path,
              type: "file",
              size: data.content?.length || 0,
              modifiedAt: data.modifiedAt || new Date(),
              createdAt: data.createdAt || new Date(),
            });
          } else {
            // Check if it's a directory
            const isDir = await this.isDirectory(db, path);
            if (isDir) {
              succeeded.push({
                path,
                type: "directory",
                size: 0,
                modifiedAt: new Date(),
                createdAt: new Date(),
              });
            } else {
              failed.push(createError(path, "not_found", "File not found"));
            }
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
    } catch (error) {
      // DB-level error
      paths.forEach((path) => {
        if (!succeeded.find((s) => s.path === path)) {
          failed.push(
            createError(
              path,
              "io_error",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      });
    }

    return { succeeded, failed };
  }

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

    // Use processPool for bounded concurrency
    const { succeeded } = await processPool(
      filePaths,
      async (filePath: string) => {
        const readResult = await this.readFiles([filePath]);
        if (readResult.succeeded.length === 0) return [];

        const file = readResult.succeeded[0];
        // Create fresh regex per worker to avoid shared lastIndex
        const workerPattern = new RegExp(pattern.source, pattern.flags);
        return searchFileContent(file.path, file.content, workerPattern);
      },
      {
        concurrency: 6,
        shouldContinue: (r) => r.length < maxResults,
      },
    );

    return succeeded.slice(0, maxResults);
  }
}
