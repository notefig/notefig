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

/**
 * Read a text file
 */
export async function readTextFileContent(
  filePath: string,
  options: ReadOptions = {},
): Promise<string> {
  try {
    return await readTextFile(filePath, {
      baseDir: options.baseDir,
    });
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }
}

/**
 * Read a binary file
 */
export async function readBinaryFile(
  filePath: string,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  try {
    return await readFile(filePath, {
      baseDir: options.baseDir,
    });
  } catch (error) {
    throw new Error(`Failed to read binary file ${filePath}: ${error}`);
  }
}

/**
 * Write a text file
 */
export async function writeTextFileContent(
  filePath: string,
  content: string,
  options: WriteOptions = {},
): Promise<void> {
  try {
    await writeTextFile(filePath, content, {
      baseDir: options.baseDir,
      append: options.append,
    });
  } catch (error) {
    throw new Error(`Failed to write file ${filePath}: ${error}`);
  }
}

/**
 * Write a binary file
 */
export async function writeBinaryFile(
  filePath: string,
  content: Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  try {
    await writeFile(filePath, content, {
      baseDir: options.baseDir,
      append: options.append,
    });
  } catch (error) {
    throw new Error(`Failed to write binary file ${filePath}: ${error}`);
  }
}

/**
 * List files and directories in a directory recursively
 */
async function listDirectoryRecursive(
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
        const subEntries = await listDirectoryRecursive(entryPath, baseDir);
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

/**
 * List files and directories in a directory
 */
export async function listDirectory(
  dirPath: string,
  options: ListOptions = {},
): Promise<FileEntry[]> {
  try {
    if (options.recursive) {
      return await listDirectoryRecursive(dirPath, options.baseDir);
    }

    const entries = await readDir(dirPath, {
      baseDir: options.baseDir,
    });

    const fileEntries: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = joinPaths(dirPath, entry.name);

      try {
        const metadata = await stat(entryPath, {
          baseDir: options.baseDir,
        });

        fileEntries.push({
          name: entry.name,
          path: entryPath,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          size: entry.isFile ? metadata.size : undefined,
          modified: metadata.mtime ? new Date(metadata.mtime) : undefined,
        });
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
  } catch (error) {
    throw new Error(`Failed to list directory ${dirPath}: ${error}`);
  }
}

/**
 * Check if a file or directory exists
 */
export async function fileExists(
  filePath: string,
  options: ReadOptions = {},
): Promise<boolean> {
  try {
    return await exists(filePath, {
      baseDir: options.baseDir,
    });
  } catch (error) {
    return false;
  }
}

/**
 * Rename a file or directory
 */
export async function renameFile(
  oldPath: string,
  newPath: string,
  options: FileOperationOptions = {},
): Promise<void> {
  try {
    await tauriRename(oldPath, newPath, {
      oldPathBaseDir: options.fromBaseDir,
      newPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });
  } catch (error) {
    throw new Error(`Failed to rename ${oldPath} to ${newPath}: ${error}`);
  }
}

/**
 * Move a file by copying and then removing the original
 */
export async function moveFile(
  sourcePath: string,
  destinationPath: string,
  options: FileOperationOptions = {},
): Promise<void> {
  try {
    // Copy the file to the new location
    await copyFile(sourcePath, destinationPath, {
      fromPathBaseDir: options.fromBaseDir,
      toPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });

    // Remove the original file
    await remove(sourcePath, {
      baseDir: options.fromBaseDir,
    });
  } catch (error) {
    throw new Error(
      `Failed to move ${sourcePath} to ${destinationPath}: ${error}`,
    );
  }
}

/**
 * Copy a file
 */
export async function copyFileToPath(
  sourcePath: string,
  destinationPath: string,
  options: FileOperationOptions = {},
): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath, {
      fromPathBaseDir: options.fromBaseDir,
      toPathBaseDir: options.toBaseDir || options.fromBaseDir,
    });
  } catch (error) {
    throw new Error(
      `Failed to copy ${sourcePath} to ${destinationPath}: ${error}`,
    );
  }
}

/**
 * Delete a file or directory
 */
export async function deleteFile(
  filePath: string,
  options: ReadOptions & { recursive?: boolean } = {},
): Promise<void> {
  try {
    await remove(filePath, {
      baseDir: options.baseDir,
      recursive: options.recursive,
    });
  } catch (error) {
    throw new Error(`Failed to delete ${filePath}: ${error}`);
  }
}

/**
 * Create a directory (and parent directories if they don't exist)
 */
export async function createDirectory(
  dirPath: string,
  options: WriteOptions & { recursive?: boolean } = {},
): Promise<void> {
  try {
    await mkdir(dirPath, {
      baseDir: options.baseDir,
      recursive: options.recursive !== false, // Default to true
    });
  } catch (error) {
    throw new Error(`Failed to create directory ${dirPath}: ${error}`);
  }
}

/**
 * Get file or directory metadata
 */
export async function getFileMetadata(
  filePath: string,
  options: ReadOptions = {},
): Promise<{
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modified: Date | null;
  accessed: Date | null;
  created: Date | null;
}> {
  try {
    const metadata = await stat(filePath, {
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
  } catch (error) {
    throw new Error(`Failed to get metadata for ${filePath}: ${error}`);
  }
}

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
 * Normalize a file path
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/") // Convert backslashes to forward slashes
    .replace(/\/+/g, "/") // Remove duplicate slashes
    .replace(/\/$/, ""); // Remove trailing slash
}

/**
 * Open a directory picker dialog and return the selected directory path
 */
export async function pickDirectory(title?: string): Promise<string | null> {
  try {
    const result = await open({
      title: title || "Select Directory",
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  } catch (error) {
    console.error("Failed to pick directory:", error);
    return null;
  }
}

/**
 * Open a file picker dialog and return the selected file path(s)
 */
export async function pickFiles(
  options: {
    title?: string;
    multiple?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  } = {},
): Promise<string | string[] | null> {
  try {
    const result = await open({
      title: options.title || "Select Files",
      directory: false,
      multiple: options.multiple || false,
      filters: options.filters,
    });

    return result;
  } catch (error) {
    console.error("Failed to pick files:", error);
    return null;
  }
}

/**
 * List files in any directory using absolute path
 * This bypasses BaseDirectory restrictions for user-selected directories
 */
export async function listAbsoluteDirectory(
  absolutePath: string,
  recursive: boolean = false,
): Promise<FileEntry[]> {
  try {
    if (recursive) {
      return await listDirectoryRecursiveAbsolute(absolutePath);
    }

    const entries = await readDir(absolutePath);
    const fileEntries: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = joinPaths(absolutePath, entry.name);

      try {
        const metadata = await stat(entryPath);

        fileEntries.push({
          name: entry.name,
          path: entryPath,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          size: entry.isFile ? metadata.size : undefined,
          modified: metadata.mtime ? new Date(metadata.mtime) : undefined,
        });
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
  } catch (error) {
    throw new Error(
      `Failed to list absolute directory ${absolutePath}: ${error}`,
    );
  }
}

/**
 * Recursive helper for absolute directory listing
 */
async function listDirectoryRecursiveAbsolute(
  dirPath: string,
): Promise<FileEntry[]> {
  const entries = await readDir(dirPath);
  const fileEntries: FileEntry[] = [];

  for (const entry of entries) {
    const entryPath = joinPaths(dirPath, entry.name);

    try {
      const metadata = await stat(entryPath);

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
        const subEntries = await listDirectoryRecursiveAbsolute(entryPath);
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

/**
 * Read a text file using absolute path
 */
export async function readAbsoluteTextFile(
  absolutePath: string,
): Promise<string> {
  try {
    return await readTextFile(absolutePath);
  } catch (error) {
    throw new Error(`Failed to read absolute file ${absolutePath}: ${error}`);
  }
}

/**
 * Write a text file using absolute path
 */
export async function writeAbsoluteTextFile(
  absolutePath: string,
  content: string,
): Promise<void> {
  try {
    await writeTextFile(absolutePath, content);
  } catch (error) {
    throw new Error(`Failed to write absolute file ${absolutePath}: ${error}`);
  }
}

/**
 * Check if an absolute path exists
 */
export async function absolutePathExists(
  absolutePath: string,
): Promise<boolean> {
  try {
    return await exists(absolutePath);
  } catch (error) {
    return false;
  }
}
