import type {
  IPlatformAdapter,
  PlatformEventListener,
  Result,
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  FileSystemChangeEvent,
} from "./platform-adapter.interface";

/**
 * Browser platform adapter
 * Implements platform-specific operations for browser/web environment
 * Uses IndexedDB for storage simulation
 */
export class BrowserPlatformAdapter implements IPlatformAdapter {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = "metrists-fs";
  private readonly DB_VERSION = 1;
  private readonly STORE_NAME = "files";

  /**
   * Initialize IndexedDB connection
   */
  private async ensureDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
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

      const results = allKeys.filter((key) => {
        // Check if key is under the target path
        if (!key.startsWith(normalizedPath)) return false;

        // Filter out hidden files/directories (starting with .)
        if (this.isHiddenPath(key)) return false;

        const relativePath = key.slice(normalizedPath.length);

        // Non-recursive: only direct children
        if (!recursive && relativePath.includes("/")) return false;

        // For now, treat all as files in browser (no real directory concept)
        return includeFiles;
      });

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

    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);

      for (const path of paths) {
        try {
          const exists = await new Promise<boolean>((resolve) => {
            const request = store.get(path);
            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => resolve(false);
          });

          results.push({ path, exists, type: exists ? "file" : undefined });
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

          succeeded.push({
            path,
            type: "file",
            size: data.content?.length || 0,
            modifiedAt: data.modifiedAt || new Date(),
            createdAt: data.createdAt || new Date(),
          });
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

  watchPaths(
    _paths: string[],
    _callback: (event: FileSystemChangeEvent) => void,
  ): () => void {
    // No file watching in browser (IndexedDB doesn't support it)
    return () => {};
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
