/**
 * Native IndexedDB storage for browser-based persistence
 * Stores files in IndexedDB using the workspace path as database name
 */

import type { FileRowData } from "./demo-data";

/**
 * IndexedDB storage wrapper for file data
 * Uses native IndexedDB API without external dependencies
 */
export class IndexedDBStorage {
  private dbName: string;
  private db: IDBDatabase | null = null;
  private readonly STORE_NAME = "files";
  private readonly DB_VERSION = 1;

  constructor(workspacePath: string) {
    // URL encode the path to avoid serialization issues
    this.dbName = encodeURIComponent(workspacePath);
  }

  /**
   * Initialize the IndexedDB database
   * Creates the database and object store if they don't exist
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.DB_VERSION);

      request.onerror = () => {
        reject(
          new Error(`Failed to open IndexedDB: ${request.error?.message}`),
        );
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          // Use 'path' as the key path
          db.createObjectStore(this.STORE_NAME, { keyPath: "path" });
          console.log(`[IndexedDB] Created object store: ${this.STORE_NAME}`);
        }
      };
    });
  }

  /**
   * Check if the database has any data
   * Returns true if there are any files stored
   */
  async hasData(): Promise<boolean> {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.STORE_NAME], "readonly");
      const objectStore = transaction.objectStore(this.STORE_NAME);
      const countRequest = objectStore.count();

      countRequest.onsuccess = () => {
        resolve(countRequest.result > 0);
      };

      countRequest.onerror = () => {
        reject(
          new Error(`Failed to count records: ${countRequest.error?.message}`),
        );
      };
    });
  }

  /**
   * Load all files from IndexedDB
   * Returns a Record mapping file paths to file data
   */
  async loadAllFiles(): Promise<Record<string, FileRowData>> {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.STORE_NAME], "readonly");
      const objectStore = transaction.objectStore(this.STORE_NAME);
      const request = objectStore.getAll();

      request.onsuccess = () => {
        const files: Record<string, FileRowData> = {};
        const results = request.result as FileRowData[];

        for (const file of results) {
          files[file.path] = file;
        }

        console.log(`[IndexedDB] Loaded ${results.length} files from database`);
        resolve(files);
      };

      request.onerror = () => {
        reject(new Error(`Failed to load files: ${request.error?.message}`));
      };
    });
  }

  /**
   * Save all files to IndexedDB
   * Clears existing data and replaces with new data
   */
  async saveAllFiles(files: Record<string, FileRowData>): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.STORE_NAME], "readwrite");
      const objectStore = transaction.objectStore(this.STORE_NAME);

      // Clear existing data
      const clearRequest = objectStore.clear();

      clearRequest.onsuccess = () => {
        // Add all files
        const fileArray = Object.values(files);
        let completed = 0;
        let hasError = false;

        if (fileArray.length === 0) {
          resolve();
          return;
        }

        for (const file of fileArray) {
          const addRequest = objectStore.add(file);

          addRequest.onsuccess = () => {
            completed++;
            if (completed === fileArray.length && !hasError) {
              console.log(
                `[IndexedDB] Saved ${fileArray.length} files to database`,
              );
              resolve();
            }
          };

          addRequest.onerror = () => {
            if (!hasError) {
              hasError = true;
              reject(
                new Error(
                  `Failed to save file ${file.path}: ${addRequest.error?.message}`,
                ),
              );
            }
          };
        }
      };

      clearRequest.onerror = () => {
        reject(
          new Error(`Failed to clear database: ${clearRequest.error?.message}`),
        );
      };
    });
  }

  /**
   * Save a single file to IndexedDB
   * Updates existing file or adds new one
   */
  async saveFile(file: FileRowData): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.STORE_NAME], "readwrite");
      const objectStore = transaction.objectStore(this.STORE_NAME);
      const request = objectStore.put(file);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to save file: ${request.error?.message}`));
      };
    });
  }

  /**
   * Delete a file from IndexedDB
   */
  async deleteFile(path: string): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.STORE_NAME], "readwrite");
      const objectStore = transaction.objectStore(this.STORE_NAME);
      const request = objectStore.delete(path);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to delete file: ${request.error?.message}`));
      };
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Delete the entire database
   * Useful for resetting a workspace
   */
  static async deleteDatabase(workspacePath: string): Promise<void> {
    const dbName = encodeURIComponent(workspacePath);

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);

      request.onsuccess = () => {
        console.log(`[IndexedDB] Deleted database: ${dbName}`);
        resolve();
      };

      request.onerror = () => {
        reject(
          new Error(`Failed to delete database: ${request.error?.message}`),
        );
      };
    });
  }
}
