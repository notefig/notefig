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

/**
 * Browser platform adapter
 * Implements platform-specific operations for browser/web environment
 * Uses IndexedDB for storage simulation
 *
 * Database name can be overridden via window.__VITE_INDEXEDDB_NAME__
 * for testing purposes. Otherwise uses a default database.
 */
export class BrowserPlatformAdapter implements IPlatformAdapter {
  private db: IDBDatabase | null = null;
  private readonly DB_VERSION = 1;
  private readonly STORE_NAME = "files";

  /**
   * Get database name
   * Checks for test override first, then falls back to default
   */
  private getDBName(): string {
    const testOverride = (window as any).__VITE_INDEXEDDB_NAME__;
    if (testOverride) {
      return testOverride;
    }
    return "metrists-fs";
  }

  /**
   * Get or create IndexedDB connection
   */
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

  /**
   * Helper to create error objects
   */
  private createError(
    path: string,
    type: FileSystemError["type"],
    message: string,
  ): FileSystemError {
    return { path, type, message };
  }

  /**
   * Check if a path contains any component that starts with a dot (hidden file/directory)
   * Examples: .git, .vscode, .DS_Store, etc.
   */
  private isHiddenPath(path: string): boolean {
    const parts = path.split("/");
    return parts.some((part) => part.startsWith(".") && part.length > 1);
  }

  /**
   * Check if a path is a directory by checking if it has children in IndexedDB
   * A directory is identified by having at least one file/directory under it
   */
  private async isDirectory(db: IDBDatabase, path: string): Promise<boolean> {
    const transaction = db.transaction([this.STORE_NAME], "readonly");
    const store = transaction.objectStore(this.STORE_NAME);

    const allKeys: string[] = await new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });

    const normalizedPath = path.endsWith("/") ? path : path + "/";

    // Check if any key starts with this path (meaning it has children)
    return allKeys.some(
      (key) => key.startsWith(normalizedPath) && key !== normalizedPath,
    );
  }

  /**
   * Get all unique directory paths under a given path
   * This extracts directory paths from file paths by analyzing the path structure
   */
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
          const dirPath = currentPath.slice(0, -1); // Remove trailing slash
          if (!this.isHiddenPath(dirPath)) {
            directories.add(dirPath);
          }
        }
      } else {
        // Only add direct child directories
        if (pathParts.length > 1) {
          const dirPath = normalizedPath + pathParts[0];
          if (!this.isHiddenPath(dirPath)) {
            directories.add(dirPath);
          }
        }
      }
    }

    return Array.from(directories);
  }

  // ========== Directory Picker ==========

  async pickDirectory(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      const event = new CustomEvent("mock-pick-directory", {
        detail: {
          title,
          callback: async (path: string | null) => {
            if (path) {
              // Seed demo data if this is the demo workspace
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

  /**
   * Seed demo data into IndexedDB
   * This is called when the user picks the /workspace/demo-content directory
   */
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

      // If there are already files for this basePath, skip seeding
      const normalizedPath = basePath.endsWith("/") ? basePath : basePath + "/";
      const existingFiles = allKeys.filter((key) =>
        key.startsWith(normalizedPath),
      );

      if (existingFiles.length > 0) {
        console.log("[BrowserAdapter] Demo data already exists, skipping seed");
        return;
      }

      console.log("[BrowserAdapter] Seeding demo data for", basePath);

      // Import demo data generator
      const { generateDemoFiles } = await import("@/utils/demo-data");
      const demoFiles = generateDemoFiles(basePath);

      // Write all demo files to IndexedDB
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
      const db = await this.ensureDB();

      // Auto-seed demo data if accessing demo workspace and DB is empty
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

      // Normalize path for comparison
      const normalizedPath = path.endsWith("/") ? path : path + "/";

      const results: string[] = [];

      // Get file paths
      if (includeFiles) {
        const filePaths = allKeys.filter((key) => {
          // Check if key is under the target path
          if (!key.startsWith(normalizedPath)) return false;

          // Filter out hidden files/directories (starting with .)
          if (this.isHiddenPath(key)) return false;

          const relativePath = key.slice(normalizedPath.length);

          // Non-recursive: only direct children
          if (!recursive && relativePath.includes("/")) return false;

          return true;
        });
        results.push(...filePaths);
      }

      // Get directory paths
      if (includeDirectories) {
        const directoryPaths = await this.getDirectories(db, path, recursive);
        results.push(...directoryPaths);
      }

      return { ok: true, value: results };
    } catch (error) {
      return {
        ok: false,
        error: this.createError(
          path,
          "io_error",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async createDirectories(paths: string[]): Promise<BatchResult<string>> {
    // In browser, directories are virtual (no-op)
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

          // Get all files under this directory
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
            failed.push(
              this.createError(path, "not_empty", "Directory not empty"),
            );
            continue;
          }

          // Delete all files
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
            this.createError(
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
            this.createError(
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

      // Get all files under old path
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

      // Read all files
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

      // Write to new locations and delete old ones
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
        error: this.createError(
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
            this.createError(
              path,
              "not_found",
              error instanceof Error ? error.message : "Unknown error",
            ),
          );
        }
      }
    } catch (error) {
      // DB-level error - fail all
      paths.forEach((path) => {
        if (!succeeded.find((s) => s.path === path)) {
          failed.push(
            this.createError(
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
            this.createError(
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
            this.createError(
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

  async createFiles(paths: string[]): Promise<BatchResult<string>> {
    return this.writeFiles(paths.map((path) => ({ path, content: "" })));
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
            this.createError(
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
            this.createError(
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

  async moveFile(oldPath: string, newPath: string): Promise<Result<void>> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      // Read old file
      const data: any = await new Promise((resolve, reject) => {
        const request = store.get(oldPath);
        request.onsuccess = () => {
          if (request.result) {
            resolve(request.result);
          } else {
            reject(new Error("File not found"));
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Write to new location
      await new Promise<void>((resolve, reject) => {
        const request = store.put({ ...data, path: newPath });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Delete old file
      await new Promise<void>((resolve, reject) => {
        const request = store.delete(oldPath);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: this.createError(
          oldPath,
          error instanceof Error && error.message === "File not found"
            ? "not_found"
            : "io_error",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async copyFile(from: string, to: string): Promise<Result<void>> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      // Read source file
      const data: any = await new Promise((resolve, reject) => {
        const request = store.get(from);
        request.onsuccess = () => {
          if (request.result) {
            resolve(request.result);
          } else {
            reject(new Error("File not found"));
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Write to new location
      await new Promise<void>((resolve, reject) => {
        const request = store.put({
          ...data,
          path: to,
          createdAt: new Date(),
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: this.createError(
          from,
          error instanceof Error && error.message === "File not found"
            ? "not_found"
            : "io_error",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
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
              failed.push(
                this.createError(path, "not_found", "File not found"),
              );
            }
          }
        } catch (error) {
          failed.push(
            this.createError(
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
            this.createError(
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

  // ========== File Watching ==========

  async startWatchingMetadata(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: Implement BroadcastChannel-based watching for cross-tab sync
    console.log("[BrowserAdapter] Metadata watching not yet implemented");
  }

  async startWatchingContent(
    _paths: string[],
    _watchId: string,
  ): Promise<void> {
    // TODO: Implement BroadcastChannel-based watching for cross-tab sync
    console.log("[BrowserAdapter] Content watching not yet implemented");
  }

  async stopWatching(_watchId: string): Promise<void> {
    // TODO: Implement stop watching when BroadcastChannel watching is implemented
    // Silently handle - no-op in browser for now
  }

  // ========== Event Listeners ==========

  addEventListener(_callback: PlatformEventListener): () => void {
    // No-op in browser - return empty cleanup function
    return () => {};
  }

  removeEventListener(_callback: PlatformEventListener): void {
    // No-op in browser
  }
}
