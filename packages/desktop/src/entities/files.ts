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

import { useMemo } from "react";
import { createCollection, useLiveQuery, eq, inArray } from "@tanstack/react-db";
import { useIsFetching } from "@tanstack/react-query";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
import { platformAdapter } from "@/adapters";
import {
  FsError,
  isWorkspaceAccessError,
} from "@/adapters/platform-adapter.interface";
import type { FileEntry } from "@/utils/fs";
import { calculateContentHash } from "@/utils/hash";
import {
  invalidateDerivedState,
  recordSelfWrite,
} from "@/utils/file-write-effects";
import { queryClient } from "./query-client";

// The shared QueryClient moved to the entities/query-client leaf; re-exported
// here so existing `@/utils/collections` import sites keep working.
export { queryClient };

const METADATA_REFETCH_INTERVAL_MS = 30_000;

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
  error?: string; // Set when the read failed — content is NOT the file's real content
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

      // Safety net for changes the fs watcher misses (network volumes,
      // watcher gaps): periodically re-read the tree from disk.
      refetchInterval: METADATA_REFETCH_INTERVAL_MS,

      // Access errors can't be retried away — fail fast so the recovery UI
      // (WorkspaceErrorBoundary) shows immediately.
      retry: (failureCount, error) =>
        !isWorkspaceAccessError(error) && failureCount < 3,

      queryFn: async (): Promise<FileMetadata[]> => {
        // Read the entire workspace directory tree
        const dirResult = await platformAdapter.readDirectory(workspaceId, {
          recursive: true,
          includeFiles: true,
          includeDirectories: true,
        });

        if (!dirResult.ok) {
          // Rethrow typed so WorkspaceErrorBoundary can recognize permission
          // failures and render the recovery fallback instead of DebugPanel.
          const { type, path, message } = dirResult.error;
          throw new FsError(type, path, message);
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

      onUpdate: async ({ transaction, collection }) => {
        // Updates to metadata only (we don't update file content here)
        // This would be used for things like renaming files
        let hasRename = false;
        for (const mutation of transaction.mutations) {
          const oldPath = String(mutation.key);
          const newPath = mutation.modified.path;

          if (oldPath !== newPath) {
            hasRename = true;
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

        // Renames change keys, so let the refetch rebuild the tree. Plain
        // metadata updates (e.g. the modified timestamp after every save)
        // must not trigger one: a full workspace scan per save is wasteful,
        // and concurrent scans can land out of order, reverting a fresh
        // timestamp to a stale one (files jump around in date-sorted trees).
        // Direct-write the confirmed values into the synced store instead so
        // state survives the optimistic overlay being dropped on commit.
        if (hasRename) return;
        collection.utils.writeUpsert(
          transaction.mutations.map((m) => m.modified),
        );
        return { refetch: false };
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

        // Create entries for all requested paths
        const contentMap = new Map<string, FileContent>();

        // Add succeeded reads
        for (const file of result.succeeded) {
          contentMap.set(file.path, {
            path: file.path,
            content: file.content,
            contentHash: calculateContentHash(file.content),
          });
        }

        // Add empty entries for failed reads (binary files like images).
        // The error field marks that content is not the file's real content,
        // so the editor must never mount from (or save over) this entry.
        for (const failure of result.failed) {
          console.warn(
            `Failed to read file ${failure.path}: ${failure.message}`,
          );
          contentMap.set(failure.path, {
            path: failure.path,
            content: "",
            contentHash: calculateContentHash(failure.path), // Use path as hash for failed reads
            error: failure.message,
          });
        }

        return Array.from(contentMap.values());
      },

      getKey: (item) => item.path,

      onUpdate: async ({ transaction, collection }) => {
        const files = transaction.mutations.map((m) => ({
          path: String(m.key),
          content: m.modified.content,
        }));

        const result = await platformAdapter.writeFiles(files);
        if (result.failed.length > 0) {
          throw new Error(
            `Failed to write files: ${result.failed.map((f) => f.message).join(", ")}`,
          );
        }

        // The app is the writer here — what we just wrote IS the file's
        // content, so re-reading every loaded file from disk (the default
        // post-mutation refetch) is redundant and, during a typing burst,
        // races later writes. Direct-write into the synced store so state
        // survives the optimistic overlay being dropped on commit.
        collection.utils.writeUpsert(
          transaction.mutations.map((m) => m.modified),
        );
        return { refetch: false };
      },

      enabled: true,

      // Mutation handlers - write content changes back to file system

      onInsert: async ({ transaction, collection }) => {
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

        // See onUpdate: our write is authoritative; skip the disk re-read.
        collection.utils.writeUpsert(
          transaction.mutations.map((m) => m.modified),
        );
        return { refetch: false };
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

if (import.meta.env.DEV) {
  // Diagnostic hook for e2e failure dumps (dev builds only).
  (window as unknown as Record<string, unknown>).__metristsDebugContentRow = (
    workspaceId: string,
    filePath: string,
  ) => {
    const collections = workspaceCollectionsRegistry.get(workspaceId);
    if (!collections) return { error: "no collections for workspace" };
    const content = collections.content.get(filePath);
    const metadata = collections.metadata.get(filePath);
    return {
      metadata,
      content: content && {
        ...content,
        content: `${content.content.slice(0, 40)} (len ${content.content.length})`,
      },
    };
  };
}

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

  // Ledger first, write second: a watcher echo of this write must find the
  // hash already recorded so it is never mistaken for an external change.
  recordSelfWrite(filePath, contentHash);

  // Update content collection (this triggers onUpdate/onInsert which writes to file system)
  const existingContent = collections.content.get(filePath);
  const tx = existingContent
    ? collections.content.update(filePath, (draft) => {
        draft.content = content;
        draft.contentHash = contentHash;
      })
    : collections.content.insert({
        path: filePath,
        content,
        contentHash,
      });

  // The disk write happens asynchronously in the mutation handler; reading
  // metadata before it lands would capture the pre-write mtime and make
  // date-sorted views flap between old and new positions.
  await tx.isPersisted.promise;

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

  // App self-writes are suppressed by the fs watcher, so derived state
  // (git status, search) must be invalidated here.
  invalidateDerivedState(workspaceId);
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
    // content and its hash must come from the same row — the content
    // collection hashes the exact string it holds. Pairing content with
    // metadata's separately-scheduled hash made FileEntry internally
    // inconsistent (loaded content + empty/stale hash).
    contentHash: content?.contentHash || metadata.contentHash,
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

    try {
      collections.content.utils.writeInsert({
        path: file.path,
        content: file.content,
        contentHash,
      });
    } catch (error) {
      // The content collection uses on-demand sync — its write context is
      // only initialized when a live query subscribes (a file tab opens).
      // Hover-prefetch before any tab opens hits this; silently skip.
      if (
        error instanceof Error &&
        error.name === "SyncNotInitializedError"
      ) {
        return;
      }
      throw error;
    }
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
  // Drop cached query state too, so a fresh open refetches instead of
  // replaying a stale error or stale data.
  queryClient.removeQueries({ queryKey: ["file-metadata", workspaceId] });
  queryClient.removeQueries({ queryKey: ["file-content", workspaceId] });
}

// ---------------------------------------------------------------------------
// Reactive hooks — the way UI reads this entity
// ---------------------------------------------------------------------------

/**
 * The workspace's collections as a render-stable pair.
 */
export function useFileCollections(workspacePath: string): WorkspaceCollections {
  return useMemo(
    () => getOrCreateWorkspaceCollections(workspacePath),
    [workspacePath],
  );
}

/**
 * A file row shaped for open tabs: metadata joined with content.
 * Content loads on demand; `isContentLoaded` is false until it arrives.
 */
export interface OpenFileRow extends FileMetadata {
  content: string;
  isContentLoaded: boolean;
  contentError?: string;
}

/**
 * Metadata ⋈ content left-join for a set of open files. Files appear as soon
 * as metadata is in (metadata loads eagerly); content follows on demand.
 */
export function useOpenFileRows(
  workspacePath: string,
  paths: string[],
): OpenFileRow[] {
  const { metadata, content } = useFileCollections(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      paths.length === 0
        ? undefined
        : q
            .from({ file: metadata })
            .where(({ file }) => inArray(file.path, paths))
            .leftJoin({ content }, ({ file, content }) =>
              eq(file.path, content.path),
            )
            .select(({ file, content }) => ({
              ...file,
              content: content?.content ?? "",
              contentHash: content?.contentHash ?? "",
              isContentLoaded: content !== undefined,
              contentError: content?.error,
            })),
    [workspacePath, ...paths],
  );
  return data as OpenFileRow[];
}

/** Whether the workspace's eager metadata load is still in flight. */
export function useMetadataFetching(workspacePath: string): boolean {
  return (
    useIsFetching({ queryKey: ["file-metadata", workspacePath] }, queryClient) >
    0
  );
}

/** Whether any on-demand content load for the workspace is in flight. */
export function useContentFetching(workspacePath: string): boolean {
  return (
    useIsFetching({ queryKey: ["file-content", workspacePath] }, queryClient) >
    0
  );
}

// ---------------------------------------------------------------------------
// One-shot reads — for non-React callers (agent tools, prompt composers).
// Identity + zero-arg methods, re-resolved live on every call, never cached.
// ---------------------------------------------------------------------------

export interface FileHandle {
  readonly workspacePath: string;
  readonly filePath: string;
  exists(): boolean;
  metadata(): FileMetadata | undefined;
  /**
   * Collection-cached content (undefined until loaded). NOT for write
   * paths — anything that patches-then-saves must read fresh from disk via
   * the platform adapter, or it risks clobbering a newer on-disk version.
   */
  content(): string | undefined;
}

export function file(workspacePath: string, filePath: string): FileHandle {
  return {
    workspacePath,
    filePath,
    exists: () =>
      getOrCreateWorkspaceCollections(workspacePath).metadata.get(filePath) !==
      undefined,
    metadata: () =>
      getOrCreateWorkspaceCollections(workspacePath).metadata.get(filePath),
    content: () =>
      getOrCreateWorkspaceCollections(workspacePath).content.get(filePath)
        ?.content,
  };
}
