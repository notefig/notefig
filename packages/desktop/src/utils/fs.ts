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
  pickDirectory(title?: string): Promise<string | null>;
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
  async pickDirectory(title?: string): Promise<string | null> {
    const result = await open({
      title: title || "Select Directory",
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
// Singleton Export
// ============================================================================

export const fs = new TauriFileSystem();

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
