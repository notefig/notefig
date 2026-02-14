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
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/query-core";
import { platformAdapter } from "@/adapters";
import type { FileEntry } from "./fs";

// Global QueryClient instance for TanStack Query
const queryClient = new QueryClient({
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
 * Helper function to compute content hash
 */
function computeContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
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
 * Content is loaded on-demand when files are opened.
 *
 * Uses a query collection but with enabled: false, so content is loaded manually.
 *
 * @param workspaceId - Unique identifier for the workspace (typically the basePath)
 */
export function createFileContentCollection(workspaceId: string) {
  return createCollection(
    queryCollectionOptions<FileContent, string>({
      queryKey: ["file-content", workspaceId],
      queryClient,

      // Don't auto-fetch - content is loaded on-demand via loadFileContent()
      queryFn: async (): Promise<FileContent[]> => {
        // Return empty array - content is loaded manually
        return [];
      },

      getKey: (item) => item.path,

      enabled: true,

      // Mutation handlers - write content changes back to file system

      onInsert: async ({ transaction }) => {
        // Insert new file content
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

      onUpdate: async ({ transaction }) => {
        // Update file content
        const files = transaction.mutations.map((m) => ({
          path: String(m.key),
          content: m.modified.content,
        }));

        const result = await platformAdapter.writeFiles(files);
        if (result.failed.length > 0) {
          throw new Error(
            `Failed to update files: ${result.failed.map((f) => f.message).join(", ")}`,
          );
        }
      },

      onDelete: async () => {
        // Content deletion is handled by metadata collection
        // This just removes from the content collection
        // No file system operation needed here
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
 * Load file content into the content collection
 *
 * Reads file content from the file system and stores it in the content collection.
 * Also updates the contentHash in the metadata collection.
 *
 * @param workspaceId - Unique identifier for the workspace
 * @param filePath - Absolute path to the file
 */
export async function loadFileContent(
  workspaceId: string,
  filePath: string,
): Promise<void> {
  console.log(`[loadFileContent] Starting load for: ${filePath}`);
  const collections = getOrCreateWorkspaceCollections(workspaceId);
  const result = await platformAdapter.readFiles([filePath]);

  console.log(`[loadFileContent] Read result:`, {
    succeeded: result.succeeded.length,
    failed: result.failed.length,
  });

  if (result.succeeded.length === 0) {
    console.error(`Failed to read file ${filePath}:`, result.failed);
    throw new Error(
      `Failed to read file: ${result.failed.length > 0 ? result.failed[0].message : "Unknown error"}`,
    );
  }

  const fileData = result.succeeded[0];
  const contentHash = computeContentHash(fileData.content);

  console.log(`[loadFileContent] File data:`, {
    path: fileData.path,
    contentLength: fileData.content.length,
    contentHash,
    contentPreview: fileData.content.substring(0, 100),
  });

  // Insert/update content in the collection
  const existingContent = collections.content.get(filePath);
  if (existingContent) {
    console.log(`[loadFileContent] Updating existing content for: ${filePath}`);
    collections.content.update(filePath, () => ({
      path: filePath,
      content: fileData.content,
      contentHash,
    }));
  } else {
    console.log(`[loadFileContent] Inserting new content for: ${filePath}`);
    collections.content.insert({
      path: filePath,
      content: fileData.content,
      contentHash,
    });
  }

  // Update metadata with hash
  const existingMetadata = collections.metadata.get(filePath);
  if (existingMetadata) {
    collections.metadata.update(filePath, (draft) => {
      draft.contentHash = contentHash;
    });
  }

  console.log(`[loadFileContent] Completed load for: ${filePath}`);
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
  const contentHash = computeContentHash(content);

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
 * @param workspaceId - Unique identifier for the workspace
 * @param path - Absolute path to delete
 */
export async function deleteFileOrDirectory(
  workspaceId: string,
  path: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  // Delete from metadata collection (triggers onDelete which removes from file system)
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
 * Clear all collections for a workspace
 * Useful when closing a workspace
 *
 * @param workspaceId - Unique identifier for the workspace
 */
export function clearWorkspaceCollections(workspaceId: string): void {
  workspaceCollectionsRegistry.delete(workspaceId);
}
