import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  readDir,
  exists,
  rename as tauriRename,
  copyFile,
  remove,
  mkdir,
  stat,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface FileEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

export interface ReadOptions {
  baseDir?: BaseDirectory;
}

export interface WriteOptions {
  baseDir?: BaseDirectory;
  append?: boolean;
}

export interface ListOptions {
  baseDir?: BaseDirectory;
  recursive?: boolean;
}

export interface FileOperationOptions {
  fromBaseDir?: BaseDirectory;
  toBaseDir?: BaseDirectory;
}

// ============================================================================
// FileSystem Interface
// ============================================================================

export interface IFileSystem {
  // Text file operations (absolute paths)
  readTextFile(absolutePath: string, options?: ReadOptions): Promise<string>;
  writeTextFile(
    absolutePath: string,
    content: string,
    options?: WriteOptions,
  ): Promise<void>;

  // Binary file operations (absolute paths)
  readBinaryFile(
    absolutePath: string,
    options?: ReadOptions,
  ): Promise<Uint8Array>;
  writeBinaryFile(
    absolutePath: string,
    content: Uint8Array,
    options?: WriteOptions,
  ): Promise<void>;

  // Directory operations (absolute paths)
  listDirectory(
    absolutePath: string,
    options?: ListOptions,
  ): Promise<FileEntry[]>;
  createDirectory(
    absolutePath: string,
    options?: WriteOptions & { recursive?: boolean },
  ): Promise<void>;

  // File/Directory checks & metadata (absolute paths)
  exists(absolutePath: string, options?: ReadOptions): Promise<boolean>;
  getMetadata(
    absolutePath: string,
    options?: ReadOptions,
  ): Promise<{
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    modified: Date | null;
    accessed: Date | null;
    created: Date | null;
  }>;

  // File/Directory manipulation (absolute paths)
  rename(
    oldPath: string,
    newPath: string,
    options?: FileOperationOptions,
  ): Promise<void>;
  copy(
    sourcePath: string,
    destinationPath: string,
    options?: FileOperationOptions,
  ): Promise<void>;
  move(
    sourcePath: string,
    destinationPath: string,
    options?: FileOperationOptions,
  ): Promise<void>;
  delete(
    absolutePath: string,
    options?: ReadOptions & { recursive?: boolean },
  ): Promise<void>;

  // Dialog operations
  pickDirectory(pickParam?: string): Promise<string | null>;
  pickFiles(options?: {
    title?: string;
    multiple?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | string[] | null>;
}

// ============================================================================
// Tauri FileSystem Implementation
// ============================================================================

class TauriFileSystem implements IFileSystem {
  // Text file operations
  async readTextFile(
    absolutePath: string,
    options: ReadOptions = {},
  ): Promise<string> {
    return await readTextFile(absolutePath, {
      baseDir: options.baseDir,
    });
  }

  async writeTextFile(
    absolutePath: string,
    content: string,
    options: WriteOptions = {},
  ): Promise<void> {
    await writeTextFile(absolutePath, content, {
      baseDir: options.baseDir,
      append: options.append,
    });
  }

  // Binary file operations
  async readBinaryFile(
    absolutePath: string,
    options: ReadOptions = {},
  ): Promise<Uint8Array> {
    return await readFile(absolutePath, {
      baseDir: options.baseDir,
    });
  }

  async writeBinaryFile(
    absolutePath: string,
    content: Uint8Array,
    options: WriteOptions = {},
  ): Promise<void> {
    await writeFile(absolutePath, content, {
      baseDir: options.baseDir,
      append: options.append,
    });
  }

  // Directory operations
  async listDirectory(
    absolutePath: string,
    options: ListOptions = {},
  ): Promise<FileEntry[]> {
    if (options.recursive) {
      return await this.listDirectoryRecursive(absolutePath, options.baseDir);
    }

    const entries = await readDir(absolutePath, {
      baseDir: options.baseDir,
    });

    const fileEntries: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = joinPaths(absolutePath, entry.name);

      try {
        const metadata = await stat(entryPath, {
          baseDir: options.baseDir,
        });

        fileEntries.push({
          name: entry.name,
          path: normalizePath(entryPath),
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          size: entry.isFile ? metadata.size : undefined,
          modified: metadata.mtime ? new Date(metadata.mtime) : undefined,
        });
      } catch (error) {
        // If we can't get metadata, still include the entry with basic info
        fileEntries.push({
          name: entry.name,
          path: normalizePath(entryPath),
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
        });
      }
    }

    return fileEntries;
  }

  async createDirectory(
    absolutePath: string,
    options: WriteOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    await mkdir(absolutePath, {
      baseDir: options.baseDir,
      recursive: options.recursive !== false, // Default to true
    });
  }

  // File/Directory checks & metadata
  async exists(
    absolutePath: string,
    options: ReadOptions = {},
  ): Promise<boolean> {
    try {
      return await exists(absolutePath, {
        baseDir: options.baseDir,
      });
    } catch (error) {
      return false;
    }
  }

  async getMetadata(
    absolutePath: string,
    options: ReadOptions = {},
  ): Promise<{
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    modified: Date | null;
    accessed: Date | null;
    created: Date | null;
  }> {
    const metadata = await stat(absolutePath, {
      baseDir: options.baseDir,
    });

    return {
      size: metadata.size,
      isFile: metadata.isFile,
      isDirectory: metadata.isDirectory,
      modified: metadata.mtime ? new Date(metadata.mtime) : null,
      accessed: metadata.atime ? new Date(metadata.atime) : null,
      created: metadata.birthtime ? new Date(metadata.birthtime) : null,
    };
  }

  // File/Directory manipulation
  async rename(
    oldPath: string,
    newPath: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    await tauriRename(oldPath, newPath, {
      oldPathBaseDir: options.fromBaseDir,
      newPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });
  }

  async copy(
    sourcePath: string,
    destinationPath: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    await copyFile(sourcePath, destinationPath, {
      fromPathBaseDir: options.fromBaseDir,
      toPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });
  }

  async move(
    sourcePath: string,
    destinationPath: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    // Copy the file to the new location
    await copyFile(sourcePath, destinationPath, {
      fromPathBaseDir: options.fromBaseDir,
      toPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });

    // Remove the original file
    await remove(sourcePath, {
      baseDir: options.fromBaseDir,
    });
  }

  async delete(
    absolutePath: string,
    options: ReadOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    await remove(absolutePath, {
      baseDir: options.baseDir,
      recursive: options.recursive,
    });
  }

  // Dialog operations
  async pickDirectory(pickParam?: string): Promise<string | null> {
    const result = await open({
      title: pickParam || "Select Directory",
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  async pickFiles(
    options: {
      title?: string;
      multiple?: boolean;
      filters?: Array<{ name: string; extensions: string[] }>;
    } = {},
  ): Promise<string | string[] | null> {
    return await open({
      title: options.title || "Select Files",
      directory: false,
      multiple: options.multiple || false,
      filters: options.filters,
    });
  }

  // Private helper methods
  private async listDirectoryRecursive(
    dirPath: string,
    baseDir?: BaseDirectory,
  ): Promise<FileEntry[]> {
    const entries = await readDir(dirPath, { baseDir });
    const fileEntries: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = joinPaths(dirPath, entry.name);

      try {
        const metadata = await stat(entryPath, { baseDir });

        fileEntries.push({
          name: entry.name,
          path: entryPath,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          size: entry.isFile ? metadata.size : undefined,
          modified: metadata.mtime ? new Date(metadata.mtime) : undefined,
        });

        // If this is a directory, recursively get its contents
        if (entry.isDirectory) {
          const subEntries = await this.listDirectoryRecursive(
            entryPath,
            baseDir,
          );
          fileEntries.push(...subEntries);
        }
      } catch (error) {
        // If we can't get metadata, still include the entry with basic info
        fileEntries.push({
          name: entry.name,
          path: entryPath,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
        });
      }
    }

    return fileEntries;
  }
}

// ============================================================================
// Browser (IndexedDB) FileSystem Implementation (WIP)
// ============================================================================

type IndexedDbContentType = "text" | "binary" | null;

interface IndexedDbEntryRecord {
  path: string;
  isFile: boolean;
  content: string | ArrayBuffer | null;
  contentType: IndexedDbContentType;
  size: number;
  modified: number;
  created: number;
}

export class IndexDbFileSystem implements IFileSystem {
  private mountedBasePath: string | null = null;
  private mountedDbName: string | null = null;
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  // --------------------------------------------------------------------------
  // Mounting / selection
  // --------------------------------------------------------------------------

  async pickDirectory(pickParam?: string): Promise<string | null> {
    if (!pickParam) return null;

    const normalizedDbName = pickParam.trim();
    if (!normalizedDbName) return null;

    return await this.mount(normalizedDbName);
  }

  async mount(dbName: string): Promise<string> {
    const normalizedDbName = dbName.trim();
    if (!normalizedDbName) {
      throw new Error("IndexDbFileSystem.mount requires a db name");
    }

    this.mountedDbName = normalizedDbName;
    this.mountedBasePath = this.normalizeBasePath(normalizedDbName);
    this.db = await this.openDb(normalizedDbName);

    await this.ensureDirectoryRecord("/");
    await this.writeTextFile(
      this.toAbsolutePath("new.md"),
      "this got created/opened",
    ).then(() => console.log("created file"));
    return this.mountedBasePath;
  }

  // --------------------------------------------------------------------------
  // Text file operations
  // --------------------------------------------------------------------------

  async readTextFile(absolutePath: string): Promise<string> {
    const innerPath = this.toInnerPath(absolutePath);

    const record = await this.getRecord(innerPath);
    if (!record || !record.isFile) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    if (record.contentType !== "text" || typeof record.content !== "string") {
      throw new Error(`Expected text content at: ${absolutePath}`);
    }

    return record.content;
  }

  async writeTextFile(
    absolutePath: string,
    content: string,
    options: WriteOptions = {},
  ): Promise<void> {
    const innerPath = this.toInnerPath(absolutePath);
    await this.ensureParentDirectories(innerPath);

    const existing = await this.getRecord(innerPath);

    let nextContent = content;
    if (options.append) {
      if (existing?.isFile && existing.contentType === "text") {
        nextContent = `${typeof existing.content === "string" ? existing.content : ""}${content}`;
      }
    }

    const now = this.now();
    const size = new TextEncoder().encode(nextContent).byteLength;

    const record: IndexedDbEntryRecord = {
      path: innerPath,
      isFile: true,
      content: nextContent,
      contentType: "text",
      size,
      modified: now,
      created: existing?.created ?? now,
    };

    await this.putRecord(record);
  }

  // --------------------------------------------------------------------------
  // Binary file operations
  // --------------------------------------------------------------------------

  async readBinaryFile(absolutePath: string): Promise<Uint8Array> {
    const innerPath = this.toInnerPath(absolutePath);

    const record = await this.getRecord(innerPath);
    if (!record || !record.isFile) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    if (record.contentType !== "binary") {
      throw new Error(`Expected binary content at: ${absolutePath}`);
    }

    if (record.content instanceof ArrayBuffer) {
      return new Uint8Array(record.content);
    }

    throw new Error(`Invalid binary content at: ${absolutePath}`);
  }

  async writeBinaryFile(
    absolutePath: string,
    content: Uint8Array,
    options: WriteOptions = {},
  ): Promise<void> {
    const innerPath = this.toInnerPath(absolutePath);
    await this.ensureParentDirectories(innerPath);

    const existing = await this.getRecord(innerPath);

    let nextBytes = content;
    if (options.append) {
      if (existing?.isFile && existing.contentType === "binary") {
        const prev =
          existing.content instanceof ArrayBuffer
            ? new Uint8Array(existing.content)
            : new Uint8Array();
        const combined = new Uint8Array(prev.length + content.length);
        combined.set(prev, 0);
        combined.set(content, prev.length);
        nextBytes = combined;
      }
    }

    const now = this.now();
    const buffer = nextBytes.buffer.slice(
      nextBytes.byteOffset,
      nextBytes.byteOffset + nextBytes.byteLength,
    ) as ArrayBuffer;

    const record: IndexedDbEntryRecord = {
      path: innerPath,
      isFile: true,
      content: buffer,
      contentType: "binary",
      size: nextBytes.byteLength,
      modified: now,
      created: existing?.created ?? now,
    };

    await this.putRecord(record);
  }

  // --------------------------------------------------------------------------
  // Directory operations
  // --------------------------------------------------------------------------

  async listDirectory(
    absolutePath: string,
    options: ListOptions = {},
  ): Promise<FileEntry[]> {
    const innerDir = this.toInnerPath(absolutePath);

    if (options.recursive) {
      return await this.listDirectoryRecursive(innerDir);
    }

    return await this.listDirectoryImmediateChildren(innerDir);
  }

  async createDirectory(
    absolutePath: string,
    options: WriteOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    const innerPath = this.toInnerPath(absolutePath);

    if (options.recursive !== false) {
      await this.ensureParentDirectories(innerPath);
    } else {
      const parent = getDirectoryPath(innerPath);
      const parentRecord = await this.getRecord(parent);
      if (!parentRecord || parentRecord.isFile) {
        throw new Error(
          `Parent directory does not exist: ${this.toAbsolutePath(parent)}`,
        );
      }
    }

    await this.ensureDirectoryRecord(innerPath);
  }

  // --------------------------------------------------------------------------
  // Checks & metadata
  // --------------------------------------------------------------------------

  async exists(absolutePath: string): Promise<boolean> {
    const innerPath = this.toInnerPath(absolutePath);
    return (await this.getRecord(innerPath)) !== undefined;
  }

  async getMetadata(absolutePath: string): Promise<{
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    modified: Date | null;
    accessed: Date | null;
    created: Date | null;
  }> {
    const innerPath = this.toInnerPath(absolutePath);
    const record = await this.getRecord(innerPath);

    if (!record) {
      throw new Error(`Path not found: ${absolutePath}`);
    }

    return {
      size: record.size,
      isFile: record.isFile,
      isDirectory: !record.isFile,
      modified: record.modified ? new Date(record.modified) : null,
      accessed: null,
      created: record.created ? new Date(record.created) : null,
    };
  }

  // --------------------------------------------------------------------------
  // Manipulation
  // --------------------------------------------------------------------------

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldInner = this.toInnerPath(oldPath);
    const newInner = this.toInnerPath(newPath);

    if (oldInner === "/") {
      throw new Error("Cannot rename mounted root directory");
    }

    if (newInner.startsWith(`${oldInner}/`)) {
      throw new Error("Cannot rename a directory into itself");
    }

    const record = await this.getRecord(oldInner);
    if (!record) {
      throw new Error(`Path not found: ${oldPath}`);
    }

    await this.ensureParentDirectories(newInner);

    if (record.isFile) {
      const now = this.now();
      await this.putRecord({ ...record, path: newInner, modified: now });
      await this.deleteRecord(oldInner);
      return;
    }

    await this.renameDirectorySubtree(oldInner, newInner);
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const sourceInner = this.toInnerPath(sourcePath);
    const destInner = this.toInnerPath(destinationPath);

    if (sourceInner === "/") {
      throw new Error("Cannot copy mounted root directory");
    }

    if (destInner.startsWith(`${sourceInner}/`)) {
      throw new Error("Cannot copy a directory into itself");
    }

    const record = await this.getRecord(sourceInner);
    if (!record) {
      throw new Error(`Path not found: ${sourcePath}`);
    }

    await this.ensureParentDirectories(destInner);

    if (record.isFile) {
      const now = this.now();
      await this.putRecord({
        ...record,
        path: destInner,
        modified: now,
        created: now,
      });
      return;
    }

    await this.copyDirectorySubtree(sourceInner, destInner);
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    await this.rename(sourcePath, destinationPath);
  }

  async delete(
    absolutePath: string,
    options: ReadOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    const innerPath = this.toInnerPath(absolutePath);

    if (innerPath === "/") {
      throw new Error("Cannot delete mounted root directory");
    }

    const record = await this.getRecord(innerPath);
    if (!record) return;

    if (record.isFile) {
      await this.deleteRecord(innerPath);
      return;
    }

    const hasDescendants = await this.hasAnyDescendants(innerPath);
    if (hasDescendants && !options.recursive) {
      throw new Error(`Directory is not empty: ${absolutePath}`);
    }

    await this.deleteDirectorySubtree(innerPath);
  }

  // --------------------------------------------------------------------------
  // Dialog operations (not supported for IndexedDB)
  // --------------------------------------------------------------------------

  async pickFiles(): Promise<string | string[] | null> {
    return null;
  }

  // --------------------------------------------------------------------------
  // Convenience (useful for debugging/tests)
  // --------------------------------------------------------------------------

  resolveInnerPath(absolutePath: string): string {
    return this.toInnerPath(absolutePath);
  }

  resolveAbsolutePath(innerPath: string): string {
    return this.toAbsolutePath(innerPath);
  }

  async preparePathForWrite(
    absolutePath: string,
  ): Promise<{ innerPath: string }> {
    const innerPath = this.toInnerPath(absolutePath);
    await this.ensureParentDirectories(innerPath);
    return { innerPath };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private normalizeBasePath(dbName: string): string {
    const maybeWithSlash = dbName.startsWith("/") ? dbName : `/${dbName}`;
    return normalizePath(maybeWithSlash);
  }

  private normalizeInnerPath(innerPath: string): string {
    return normalizePath(innerPath);
  }

  private getMounted(): {
    basePath: string;
    dbName: string;
    db: IDBDatabase;
  } {
    if (!this.mountedBasePath || !this.mountedDbName || !this.db) {
      throw new Error(
        "IndexDbFileSystem is not mounted. Call mount(dbName) first.",
      );
    }

    return {
      basePath: this.mountedBasePath,
      dbName: this.mountedDbName,
      db: this.db,
    };
  }

  private toInnerPath(absolutePath: string): string {
    const { basePath } = this.getMounted();

    const normalizedAbsolutePath = normalizePath(absolutePath);

    if (normalizedAbsolutePath === basePath) {
      return "/";
    }

    const baseWithSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;

    if (!normalizedAbsolutePath.startsWith(baseWithSlash)) {
      throw new Error(
        `Path "${normalizedAbsolutePath}" is outside mounted base "${basePath}"`,
      );
    }

    const remainder = normalizedAbsolutePath.slice(baseWithSlash.length);
    return this.normalizeInnerPath(`/${remainder}`);
  }

  private toAbsolutePath(innerPath: string): string {
    const { basePath } = this.getMounted();

    const normalizedInner = this.normalizeInnerPath(innerPath);
    if (normalizedInner === "/") {
      return basePath;
    }

    return normalizePath(`${basePath}/${normalizedInner.slice(1)}`);
  }

  private async openDb(dbName: string): Promise<IDBDatabase> {
    if (this.db && this.mountedDbName === dbName) {
      return this.db;
    }

    if (this.openPromise && this.mountedDbName === dbName) {
      return this.openPromise;
    }

    const idbFactory = globalThis.indexedDB;
    if (!idbFactory) {
      throw new Error("IndexedDB is not available in this environment");
    }

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = idbFactory.open(dbName, 1);

      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("entries")) {
          database.createObjectStore("entries", { keyPath: "path" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    }).finally(() => {
      this.openPromise = null;
    });

    return this.openPromise;
  }

  private requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const { db } = this.getMounted();

    const tx = db.transaction("entries", mode);
    const store = tx.objectStore("entries");

    const result = await fn(store);
    await this.transactionDone(tx);

    return result;
  }

  private now(): number {
    return Date.now();
  }

  private async ensureDirectoryRecord(innerDirPath: string): Promise<void> {
    const path = this.normalizeInnerPath(innerDirPath);

    await this.withStore("readwrite", async (store) => {
      const existing = await this.requestToPromise<
        IndexedDbEntryRecord | undefined
      >(store.get(path) as IDBRequest<IndexedDbEntryRecord | undefined>);

      if (existing) return;

      const now = this.now();
      const record: IndexedDbEntryRecord = {
        path,
        isFile: false,
        content: null,
        contentType: null,
        size: 0,
        modified: now,
        created: now,
      };

      store.put(record);
      return;
    });
  }

  private async ensureParentDirectories(innerPath: string): Promise<void> {
    const path = this.normalizeInnerPath(innerPath);

    if (path === "/") {
      await this.ensureDirectoryRecord("/");
      return;
    }

    const segments = path.split("/").filter(Boolean);
    let current = "";

    // Ensure root first
    await this.ensureDirectoryRecord("/");

    // Ensure each parent directory path exists
    for (let i = 0; i < segments.length - 1; i++) {
      current = `${current}/${segments[i]}`;
      await this.ensureDirectoryRecord(current);
    }
  }

  private getNameFromInnerPath(innerPath: string): string {
    if (innerPath === "/") return "/";
    return innerPath.split("/").filter(Boolean).pop() || "/";
  }

  private recordToFileEntry(record: IndexedDbEntryRecord): FileEntry {
    const name = this.getNameFromInnerPath(record.path);

    return {
      name,
      path: this.toAbsolutePath(record.path),
      isFile: record.isFile,
      isDirectory: !record.isFile,
      size: record.isFile ? record.size : undefined,
      modified: record.modified ? new Date(record.modified) : undefined,
    };
  }

  private async getRecord(
    innerPath: string,
  ): Promise<IndexedDbEntryRecord | undefined> {
    const path = this.normalizeInnerPath(innerPath);

    return await this.withStore("readonly", async (store) => {
      return await this.requestToPromise<IndexedDbEntryRecord | undefined>(
        store.get(path) as IDBRequest<IndexedDbEntryRecord | undefined>,
      );
    });
  }

  private async putRecord(record: IndexedDbEntryRecord): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      store.put(record);
      return;
    });
  }

  private async deleteRecord(innerPath: string): Promise<void> {
    const path = this.normalizeInnerPath(innerPath);

    await this.withStore("readwrite", async (store) => {
      store.delete(path);
      return;
    });
  }

  private async listRecordsByKeyRange(
    range: IDBKeyRange,
  ): Promise<IndexedDbEntryRecord[]> {
    return await this.withStore("readonly", async (store) => {
      return await new Promise<IndexedDbEntryRecord[]>((resolve, reject) => {
        const records: IndexedDbEntryRecord[] = [];
        const request = store.openCursor(range);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(records);
            return;
          }

          records.push(cursor.value as IndexedDbEntryRecord);
          cursor.continue();
        };
      });
    });
  }

  private getPrefixRange(prefix: string): IDBKeyRange {
    return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  }

  private async listDirectoryRecursive(innerDir: string): Promise<FileEntry[]> {
    const dir = this.normalizeInnerPath(innerDir);

    const prefix = dir === "/" ? "/" : `${dir}/`;
    const records = await this.listRecordsByKeyRange(
      this.getPrefixRange(prefix),
    );

    return records
      .filter((r) => r.path !== dir)
      .map((r) => this.recordToFileEntry(r));
  }

  private async listDirectoryImmediateChildren(
    innerDir: string,
  ): Promise<FileEntry[]> {
    const dir = this.normalizeInnerPath(innerDir);

    const prefix = dir === "/" ? "/" : `${dir}/`;
    const records = await this.listRecordsByKeyRange(
      this.getPrefixRange(prefix),
    );

    const children = new Map<
      string,
      { record?: IndexedDbEntryRecord; inferredDirectory: boolean }
    >();

    for (const record of records) {
      if (record.path === dir) continue;

      const remainder =
        dir === "/" ? record.path.slice(1) : record.path.slice(prefix.length);
      if (!remainder) continue;

      const firstSegment = remainder.split("/")[0];
      const childInner =
        dir === "/" ? `/${firstSegment}` : `${prefix}${firstSegment}`;

      const current = children.get(childInner);

      const isDirectChild = record.path === childInner;
      const inferredDirectory = !isDirectChild;

      if (!current) {
        children.set(childInner, {
          record: isDirectChild ? record : undefined,
          inferredDirectory,
        });
        continue;
      }

      if (isDirectChild) {
        current.record = record;
        current.inferredDirectory = false;
        children.set(childInner, current);
      } else {
        children.set(childInner, {
          ...current,
          inferredDirectory: current.inferredDirectory || true,
        });
      }
    }

    const fileEntries: FileEntry[] = [];

    for (const [childPath, info] of children.entries()) {
      if (info.record) {
        fileEntries.push(this.recordToFileEntry(info.record));
        continue;
      }

      // Directory inferred from descendants (or missing directory record)
      fileEntries.push({
        name: this.getNameFromInnerPath(childPath),
        path: this.toAbsolutePath(childPath),
        isFile: false,
        isDirectory: true,
      });
    }

    return fileEntries;
  }

  private async hasAnyDescendants(innerDir: string): Promise<boolean> {
    const dir = this.normalizeInnerPath(innerDir);
    const prefix = dir === "/" ? "/" : `${dir}/`;

    return await this.withStore("readonly", async (store) => {
      return await new Promise<boolean>((resolve, reject) => {
        const request = store.openCursor(this.getPrefixRange(prefix));

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(false);
            return;
          }

          const record = cursor.value as IndexedDbEntryRecord;
          if (record.path !== dir) {
            resolve(true);
            return;
          }

          cursor.continue();
        };
      });
    });
  }

  private async getDirectorySubtreeRecords(
    dirInner: string,
  ): Promise<IndexedDbEntryRecord[]> {
    const dir = this.normalizeInnerPath(dirInner);

    const dirRecord = await this.getRecord(dir);
    if (!dirRecord) {
      throw new Error(`Directory not found: ${this.toAbsolutePath(dir)}`);
    }

    if (dirRecord.isFile) {
      throw new Error(`Expected a directory: ${this.toAbsolutePath(dir)}`);
    }

    const prefix = dir === "/" ? "/" : `${dir}/`;
    const descendants = await this.listRecordsByKeyRange(
      this.getPrefixRange(prefix),
    );

    // Ensure the directory record itself is included
    const filtered = descendants.filter((r) => r.path !== dir);
    return [dirRecord, ...filtered];
  }

  private async renameDirectorySubtree(
    oldInner: string,
    newInner: string,
  ): Promise<void> {
    const oldDir = this.normalizeInnerPath(oldInner);
    const newDir = this.normalizeInnerPath(newInner);

    const records = await this.getDirectorySubtreeRecords(oldDir);
    await this.ensureParentDirectories(newDir);

    await this.withStore("readwrite", async (store) => {
      const now = this.now();

      for (const record of records) {
        const updatedPath =
          record.path === oldDir
            ? newDir
            : this.normalizeInnerPath(
                `${newDir}${record.path.slice(oldDir.length)}`,
              );

        store.put({ ...record, path: updatedPath, modified: now });
      }

      for (const record of records) {
        store.delete(record.path);
      }

      return;
    });
  }

  private async copyDirectorySubtree(
    sourceInner: string,
    destInner: string,
  ): Promise<void> {
    const sourceDir = this.normalizeInnerPath(sourceInner);
    const destDir = this.normalizeInnerPath(destInner);

    const records = await this.getDirectorySubtreeRecords(sourceDir);
    await this.ensureParentDirectories(destDir);

    await this.withStore("readwrite", async (store) => {
      const now = this.now();

      for (const record of records) {
        const updatedPath =
          record.path === sourceDir
            ? destDir
            : this.normalizeInnerPath(
                `${destDir}${record.path.slice(sourceDir.length)}`,
              );

        store.put({
          ...record,
          path: updatedPath,
          modified: now,
          created: now,
        });
      }

      return;
    });
  }

  private async deleteDirectorySubtree(dirInner: string): Promise<void> {
    const dir = this.normalizeInnerPath(dirInner);
    const records = await this.getDirectorySubtreeRecords(dir);

    await this.withStore("readwrite", async (store) => {
      for (const record of records) {
        store.delete(record.path);
      }
      return;
    });
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const fs = new IndexDbFileSystem();

// ============================================================================
// Pure Utility Functions (separate from singleton)
// ============================================================================

/**
 * Get the file extension from a file path
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * Get the file name without extension from a file path
 */
export function getFileNameWithoutExtension(filePath: string): string {
  const fileName = filePath.split("/").pop() || filePath;
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : fileName;
}

/**
 * Get the directory path from a file path
 */
export function getDirectoryPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/") || "/";
}

/**
 * Join path components
 */
export function joinPaths(...paths: string[]): string {
  return paths
    .filter((path) => path && path.length > 0)
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * Normalize a file path by ensuring it starts with a leading slash
 * and removing duplicate slashes and trailing slashes
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return "/";

  let normalized = filePath
    .replace(/\\/g, "/") // Convert backslashes to forward slashes
    .replace(/\/+/g, "/"); // Remove duplicate slashes

  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash unless it's the root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

// ============================================================================
// Re-exports
// ============================================================================

export { BaseDirectory };
