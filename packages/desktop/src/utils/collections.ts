/**
 * TanStack DB collections for file system data
 *
 * We use two separate collections to optimize performance:
 * 1. File Metadata Collection - Contains all metadata (type, size, modified, hash, etc.) but NOT content
 * 2. File Content Collection - Contains only path and content (loaded separately on demand)
 *
 * This split allows us to:
 * - Quickly load and display file trees without loading all file contents
 * - Load file content only when needed (when user opens a file)
 * - Keep metadata reactive and fast to query
 * - Join the two collections when full FileEntry data is needed
 *
 * We use TanStack Query's queryCollectionOptions because:
 * - File system (local or remote) is a data source we query
 * - Mutations write back to the source via platform adapter
 * - Works with both local (Tauri/Browser) and future remote adapters (S3, Dropbox, etc.)
 * - Provides error handling, loading states, and retry logic
 * - We control when to refetch via manual .refetch() calls
 */

import { createCollection } from "@tanstack/react-db";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/query-core";
import { platformAdapter } from "@/adapters";
import type { FileEntry } from "./fs";
import { calculateContentHash } from "./hash";
import type { Theme } from "@/components/theme-provider";

// Global QueryClient instance for TanStack Query
export const queryClient = new QueryClient({
  defaultOptions: {},
});

/**
 * File Metadata Type
 * Excludes content to keep metadata queries lightweight
 */
export interface FileMetadata {
  path: string; // Absolute path - serves as the key
  relativePath?: string; // Relative to workspace (optional for loose files)
  type: "file" | "directory";
  modified?: Date; // Date object
  size?: number;
  contentHash: string;
  error?: string;
}

/**
 * File Content Type
 * Contains only path (foreign key) and content
 */
export interface FileContent {
  path: string; // Absolute path - foreign key to metadata
  content: string;
  contentHash: string; // Hash of the content
}

/**
 * Create a file metadata collection for a workspace
 *
 * Uses TanStack Query to fetch metadata from the file system.
 * Supports both local (Tauri/Browser) and remote (future) adapters.
 *
 * @param workspaceId - Unique identifier for the workspace (typically the basePath)
 */
export function createFileMetadataCollection(workspaceId: string) {
  return createCollection(
    queryCollectionOptions<FileMetadata, string>({
      queryKey: ["file-metadata", workspaceId],
      queryClient,

      queryFn: async (): Promise<FileMetadata[]> => {
        // Read the entire workspace directory tree
        const dirResult = await platformAdapter.readDirectory(workspaceId, {
          recursive: true,
          includeFiles: true,
          includeDirectories: true,
        });

        if (!dirResult.ok) {
          throw new Error(
            `Failed to read directory ${workspaceId}: ${dirResult.error.message}`,
          );
        }

        const paths = dirResult.value;

        // Get metadata for all paths
        const metadataResult = await platformAdapter.getMetadata(paths);

        // Map to FileMetadata format
        const metadata: FileMetadata[] = metadataResult.succeeded.map((m) => ({
          path: m.path,
          relativePath: m.path.startsWith(workspaceId)
            ? m.path.slice(workspaceId.length + 1)
            : undefined,
          type: m.type,
          modified: m.modifiedAt,
          size: m.size,
          contentHash: "", // Will be computed when content is loaded
        }));

        // Log any failures
        if (metadataResult.failed.length > 0) {
          console.warn(
            "Failed to get metadata for some paths:",
            metadataResult.failed,
          );
        }

        return metadata;
      },

      getKey: (item) => item.path,

      // Mutation handlers - write changes back to file system

      onInsert: async ({ transaction }) => {
        // Create new files or directories
        const files = transaction.mutations
          .filter((m) => m.modified.type === "file")
          .map((m) => m.modified.path);

        const directories = transaction.mutations
          .filter((m) => m.modified.type === "directory")
          .map((m) => m.modified.path);

        if (files.length > 0) {
          const result = await platformAdapter.createFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to create files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result = await platformAdapter.createDirectories(directories);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to create directories: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }
      },

      onUpdate: async ({ transaction }) => {
        // Updates to metadata only (we don't update file content here)
        // This would be used for things like renaming files
        for (const mutation of transaction.mutations) {
          const oldPath = String(mutation.key);
          const newPath = mutation.modified.path;

          if (oldPath !== newPath) {
            // This is a rename/move operation
            const original = mutation.original;
            if (original.type === "file") {
              const moveResult = await platformAdapter.moveFile(
                oldPath,
                newPath,
              );
              if (!moveResult.ok) {
                throw new Error(
                  `Failed to move file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
                );
              }
            } else {
              const moveResult = await platformAdapter.moveDirectory(
                oldPath,
                newPath,
              );
              if (!moveResult.ok) {
                throw new Error(
                  `Failed to move directory ${oldPath} to ${newPath}: ${moveResult.error.message}`,
                );
              }
            }
          }
        }
      },

      onDelete: async ({ transaction }) => {
        // Delete files and directories
        const files = transaction.mutations
          .filter((m) => m.original.type === "file")
          .map((m) => String(m.key));

        const directories = transaction.mutations
          .filter((m) => m.original.type === "directory")
          .map((m) => String(m.key));

        if (files.length > 0) {
          const result = await platformAdapter.deleteFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to delete files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result = await platformAdapter.deleteDirectories(directories, {
            recursive: true,
          });
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to delete directories: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }
      },
    }),
  );
}

/**
 * Create a file content collection for a workspace
 *
 * This collection stores file contents separately from metadata.
 * Content is loaded on-demand when queried via TanStack DB's automatic loading.
 *
 * How it works:
 * - Uses syncMode: "on-demand" to load only requested files
 * - When a query includes a where clause on the 'path' field, TanStack DB triggers queryFn
 * - queryFn uses parseLoadSubsetOptions to extract requested paths from the query
 * - Only those specific files are loaded from the file system
 *
 * Example query that triggers loading:
 * ```ts
 * q.from({ content })
 *   .where(({ content }) => inArray(content.path, ['/path/to/file.md']))
 * ```
 *
 * @param workspaceId - Unique identifier for the workspace (typically the basePath)
 */
export function createFileContentCollection(workspaceId: string) {
  return createCollection(
    queryCollectionOptions<FileContent>({
      queryKey: ["file-content", workspaceId],
      queryClient,

      syncMode: "on-demand",

      queryFn: async (context): Promise<FileContent[]> => {
        const parsed = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);

        // Extract path filters (eq or in operators on 'path' field)
        const pathFilters = parsed.filters.filter(
          (f) =>
            f.field.join(".") === "path" &&
            (f.operator === "eq" || f.operator === "in"),
        );

        // Collect all requested paths
        const requestedPaths = pathFilters.flatMap((f) =>
          Array.isArray(f.value) ? f.value : [f.value],
        );

        if (requestedPaths.length === 0) return [];

        // Load file contents from file system
        const result = await platformAdapter.readFiles(requestedPaths);

        if (result.failed.length > 0) {
          console.warn(
            "Failed to read some files:",
            result.failed.map((f) => f.message).join(", "),
          );
        }

        // Map to FileContent format
        return result.succeeded.map((file) => ({
          path: file.path,
          content: file.content,
          contentHash: calculateContentHash(file.content),
        }));
      },

      getKey: (item) => item.path,

      onUpdate: async ({ transaction }) => {
        const files = transaction.mutations.map((m) => ({
          path: String(m.key),
          content: m.modified.content,
        }));

        await platformAdapter.writeFiles(files);
      },

      enabled: true,

      // Mutation handlers - write content changes back to file system

      onInsert: async ({ transaction }) => {
        const files = transaction.mutations.map((m) => ({
          path: m.modified.path,
          content: m.modified.content,
        }));

        const result = await platformAdapter.writeFiles(files);
        if (result.failed.length > 0) {
          throw new Error(
            `Failed to write files: ${result.failed.map((f) => f.message).join(", ")}`,
          );
        }
      },

      onDelete: async () => {
        // No-op
      },
    }),
  );
}

/**
 * Type for the combined metadata + content collections for a workspace
 */
export interface WorkspaceCollections {
  metadata: ReturnType<typeof createFileMetadataCollection>;
  content: ReturnType<typeof createFileContentCollection>;
}

/**
 * Global registry of workspace collections
 * Maps workspace ID to its collections
 */
const workspaceCollectionsRegistry = new Map<string, WorkspaceCollections>();

/**
 * Get or create collections for a workspace
 *
 * @param workspaceId - Unique identifier for the workspace (typically the basePath)
 * @returns The metadata and content collections for the workspace
 */
export function getOrCreateWorkspaceCollections(
  workspaceId: string,
): WorkspaceCollections {
  let collections = workspaceCollectionsRegistry.get(workspaceId);

  if (!collections) {
    collections = {
      metadata: createFileMetadataCollection(workspaceId),
      content: createFileContentCollection(workspaceId),
    };
    workspaceCollectionsRegistry.set(workspaceId, collections);
  }

  return collections;
}

/**
 * Refresh directory metadata from the file system
 *
 * Triggers a refetch of the metadata collection, reloading all file/directory metadata.
 * Call this when you know files have changed on disk.
 *
 * @param workspaceId - Unique identifier for the workspace
 */
export async function refreshDirectoryMetadata(
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);
  await collections.metadata.utils.refetch();
}

/**
 * Write file content to the file system and update collections
 *
 * This uses the collection's mutation handler, which automatically writes to the file system.
 * After writing, it updates the metadata collection with the new timestamp and size.
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param filePath - Absolute path to the file
 * @param content - New file content
 */
export async function writeFileContent(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);
  const contentHash = calculateContentHash(content);

  // Update content collection (this triggers onUpdate/onInsert which writes to file system)
  const existingContent = collections.content.get(filePath);
  if (existingContent) {
    collections.content.update(filePath, (draft) => {
      draft.content = content;
      draft.contentHash = contentHash;
    });
  } else {
    collections.content.insert({
      path: filePath,
      content,
      contentHash,
    });
  }

  // Update metadata with new timestamp and hash
  const metadataResult = await platformAdapter.getMetadata([filePath]);
  if (metadataResult.succeeded.length > 0) {
    const metadata = metadataResult.succeeded[0];
    const existingMetadata = collections.metadata.get(filePath);
    if (existingMetadata) {
      collections.metadata.update(filePath, (draft) => {
        draft.modified = metadata.modifiedAt;
        draft.size = metadata.size;
        draft.contentHash = contentHash;
      });
    }
  }
}

/**
 * Create a new file in the file system
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param filePath - Absolute path to the new file
 * @param content - Initial file content (optional, defaults to empty string)
 */
export async function createFile(
  workspaceId: string,
  filePath: string,
  content: string = "",
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  // Insert into metadata collection (triggers onCreate which creates the file)
  collections.metadata.insert({
    path: filePath,
    relativePath: filePath.startsWith(workspaceId)
      ? filePath.slice(workspaceId.length + 1)
      : undefined,
    type: "file",
    contentHash: "",
    size: 0,
  });

  // If content is provided, write it
  if (content) {
    await writeFileContent(workspaceId, filePath, content);
  }

  // Refresh metadata to get accurate timestamps
  const metadataResult = await platformAdapter.getMetadata([filePath]);
  if (metadataResult.succeeded.length > 0) {
    const metadata = metadataResult.succeeded[0];
    collections.metadata.update(filePath, (draft) => {
      draft.modified = metadata.modifiedAt;
      draft.size = metadata.size;
    });
  }
}

/**
 * Create a new directory in the file system
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param dirPath - Absolute path to the new directory
 */
export async function createDirectory(
  workspaceId: string,
  dirPath: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  // Insert into metadata collection (triggers onCreate which creates the directory)
  collections.metadata.insert({
    path: dirPath,
    relativePath: dirPath.startsWith(workspaceId)
      ? dirPath.slice(workspaceId.length + 1)
      : undefined,
    type: "directory",
    contentHash: "",
  });

  // Refresh metadata to get accurate timestamps
  const metadataResult = await platformAdapter.getMetadata([dirPath]);
  if (metadataResult.succeeded.length > 0) {
    const metadata = metadataResult.succeeded[0];
    collections.metadata.update(dirPath, (draft) => {
      draft.modified = metadata.modifiedAt;
      draft.size = metadata.size;
    });
  }
}

/**
 * Delete a file or directory
 *
 * For directories, this cascades the delete to all children:
 * - All child metadata and content entries are removed from collections via direct writes
 *   (bypasses mutation handlers since the recursive FS delete handles them on disk)
 * - The directory entry itself is deleted via the mutation handler which calls
 *   platformAdapter.deleteDirectories with recursive: true
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param path - Absolute path to delete
 */
export async function deleteFileOrDirectory(
  workspaceId: string,
  path: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  const entry = collections.metadata.get(path);

  if (entry?.type === "directory") {
    // For directories, remove all children from collections first.
    // Use direct writes (utils.writeDelete) to bypass mutation handlers —
    // the platform adapter's recursive directory delete handles the FS cleanup.
    const childPrefix = path.endsWith("/") ? path : path + "/";
    const allMetadata = collections.metadata.toArray;

    for (const child of allMetadata) {
      if (child.path.startsWith(childPrefix)) {
        // Remove child content if loaded
        const childContent = collections.content.get(child.path);
        if (childContent) {
          collections.content.utils.writeDelete(child.path);
        }
        // Remove child metadata
        collections.metadata.utils.writeDelete(child.path);
      }
    }
  }

  // Delete the entry itself from metadata (triggers onDelete -> platform adapter)
  collections.metadata.delete(path);

  // Also delete content if it exists
  const content = collections.content.get(path);
  if (content) {
    collections.content.delete(path);
  }
}

/**
 * Get a full FileEntry by joining metadata and content
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param filePath - Absolute path to the file
 * @returns Full FileEntry or null if not found
 */
export function getFileEntry(
  workspaceId: string,
  filePath: string,
): FileEntry | null {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  const metadata = collections.metadata.get(filePath);
  const content = collections.content.get(filePath);

  if (!metadata) {
    return null;
  }

  return {
    path: metadata.path,
    relativePath: metadata.relativePath,
    type: metadata.type,
    modified: metadata.modified,
    size: metadata.size,
    contentHash: metadata.contentHash,
    content: content?.content || "",
    error: metadata.error,
  };
}

/**
 * Prefetch file content for a specific file
 * This pre-loads file content into the collection cache before the user opens it.
 * Useful for hover-based prefetching to improve perceived performance.
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param filePath - Absolute path to the file to prefetch
 */
export async function prefetchFileContent(
  workspaceId: string,
  filePath: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  const existingContent = collections.content.get(filePath);
  if (existingContent) {
    return;
  }

  const result = await platformAdapter.readFiles([filePath]);

  if (result.succeeded.length > 0) {
    const file = result.succeeded[0];
    const contentHash = calculateContentHash(file.content);

    collections.content.utils.writeInsert({
      path: file.path,
      content: file.content,
      contentHash,
    });
  }
}

/**
 * Rename (move) a file or directory
 *
 * For files: moves the file on disk, then re-keys the metadata and content entries.
 * For directories: moves the directory on disk, then re-keys the directory entry
 * and all descendant metadata/content entries.
 *
 * All collection writes use direct writes (utils.writeDelete/writeInsert) to bypass
 * mutation handlers — the FS operation is done directly via the platform adapter.
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param oldPath - Current absolute path
 * @param newPath - New absolute path
 */
export async function renameFileOrDirectory(
  workspaceId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) return;

  const collections = getOrCreateWorkspaceCollections(workspaceId);
  const entry = collections.metadata.get(oldPath);

  if (!entry) {
    throw new Error(`Cannot rename: no metadata entry found for ${oldPath}`);
  }

  // Check for duplicate at target path
  const existing = collections.metadata.get(newPath);
  if (existing) {
    throw new Error(
      `Cannot rename: a file or directory already exists at ${newPath}`,
    );
  }

  const computeRelativePath = (absolutePath: string): string | undefined =>
    absolutePath.startsWith(workspaceId)
      ? absolutePath.slice(workspaceId.length + 1)
      : undefined;

  if (entry.type === "file") {
    // Move on disk first
    const moveResult = await platformAdapter.moveFile(oldPath, newPath);
    if (!moveResult.ok) {
      throw new Error(
        `Failed to rename file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
      );
    }

    // Re-key metadata: delete old, insert new
    collections.metadata.utils.writeDelete(oldPath);
    collections.metadata.utils.writeInsert({
      ...entry,
      path: newPath,
      relativePath: computeRelativePath(newPath),
    });

    // Re-key content if loaded
    const contentEntry = collections.content.get(oldPath);
    if (contentEntry) {
      collections.content.utils.writeDelete(oldPath);
      collections.content.utils.writeInsert({
        ...contentEntry,
        path: newPath,
      });
    }
  } else {
    // Directory rename
    const moveResult = await platformAdapter.moveDirectory(oldPath, newPath);
    if (!moveResult.ok) {
      throw new Error(
        `Failed to rename directory ${oldPath} to ${newPath}: ${moveResult.error.message}`,
      );
    }

    // Re-key all children
    const childPrefix = oldPath.endsWith("/") ? oldPath : oldPath + "/";
    const allMetadata = collections.metadata.toArray;

    for (const child of allMetadata) {
      if (child.path.startsWith(childPrefix)) {
        const newChildPath = newPath + child.path.slice(oldPath.length);

        // Re-key child metadata
        collections.metadata.utils.writeDelete(child.path);
        collections.metadata.utils.writeInsert({
          ...child,
          path: newChildPath,
          relativePath: computeRelativePath(newChildPath),
        });

        // Re-key child content if loaded
        const childContent = collections.content.get(child.path);
        if (childContent) {
          collections.content.utils.writeDelete(child.path);
          collections.content.utils.writeInsert({
            ...childContent,
            path: newChildPath,
          });
        }
      }
    }

    // Re-key the directory entry itself
    collections.metadata.utils.writeDelete(oldPath);
    collections.metadata.utils.writeInsert({
      ...entry,
      path: newPath,
      relativePath: computeRelativePath(newPath),
    });
  }
}

/**
 * Clear all collections for a workspace
 * Useful when closing a workspace
 *
 * @param workspaceId - Unique identifier for the workspace
 */
export function clearWorkspaceCollections(workspaceId: string): void {
  workspaceCollectionsRegistry.delete(workspaceId);
}
export interface AppSettingRow {
  key: string;
  value: unknown;
}

export interface AppSettings {
  theme: Theme;
  lastPath: string | null;
  zoomLevel: number;
}

export const SETTING_KEYS: (keyof AppSettings)[] = [
  "theme",
  "lastPath",
  "zoomLevel",
];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
  lastPath: null,
  zoomLevel: 1,
};

export const SETTINGS_NAMESPACE = "settings";

function createSettingsCollection() {
  return createCollection(
    queryCollectionOptions<AppSettingRow, string>({
      queryKey: ["app-settings"],
      queryClient,

      queryFn: async (): Promise<AppSettingRow[]> => {
        const raw = await platformAdapter.getAllKv<unknown>(SETTINGS_NAMESPACE);
        return Object.entries(raw).map(([key, value]) => ({ key, value }));
      },

      getKey: (item) => item.key,

      onInsert: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          await platformAdapter.setKv(
            SETTINGS_NAMESPACE,
            m.modified.key,
            m.modified.value,
          );
        }
      },

      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          await platformAdapter.setKv(
            SETTINGS_NAMESPACE,
            m.modified.key,
            m.modified.value,
          );
        }
      },
    }),
  );
}

type SettingsCollection = ReturnType<typeof createSettingsCollection>;
let _settingsCollection: SettingsCollection | null = null;

export function getOrCreateSettingsCollection(): SettingsCollection {
  if (!_settingsCollection) {
    _settingsCollection = createSettingsCollection();
  }
  return _settingsCollection;
}
