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
import {
  createCollection,
  useLiveQuery,
  eq,
  inArray,
  coalesce,
  isUndefined,
  not,
} from "@tanstack/react-db";
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
import { IGNORE_RULES } from "@/utils/ignore";
import { calculateContentHash } from "@/utils/hash";
import { invalidateDerivedState } from "@/utils/file-write-effects";
import { path as pathutil, relativeTreePath } from "@/utils/path";
import { queryClient } from "./query-client";

// The shared QueryClient moved to the entities/query-client leaf; re-exported
// here so existing `@/utils/collections` import sites keep working.
export { queryClient };

const METADATA_REFETCH_INTERVAL_MS = 30_000;

/** Temporary MET-135 diagnostics — grep for [scratchpad-debug]. */
function scratchpadDebug(...parts: unknown[]): void {
  console.info("[scratchpad-debug]", ...parts);
}

/** Excludes content to keep metadata queries lightweight. */
export interface FileMetadata {
  path: string; // Absolute path - serves as the key
  relativePath?: string; // Relative to workspace (optional for loose files)
  type: "file" | "directory";
  modified?: Date; // Date object
  size?: number;
  contentHash: string;
  error?: string;
}

export interface FileContent {
  path: string; // Absolute path - foreign key to metadata
  content: string;
  contentHash: string; // Hash of the content
  error?: string; // Set when the read failed — content is NOT the file's real content
}

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

      // Listing only — no per-path stat batch. Stats (modified/size)
      // hydrate per directory via hydrateDirectoryStats when the tree
      // shows it; the refetch re-stats already-hydrated directories so the
      // 30s cycle stays cheap on large workspaces. Two walks (files, then
      // dirs) because the listing API returns bare paths and rows need a
      // type; the walk is the cheap half of the old scan.
      queryFn: async (): Promise<FileMetadata[]> => {
        const walkOptions = { recursive: true, ignore: IGNORE_RULES };
        const [filesResult, dirsResult] = await Promise.all([
          platformAdapter.fs.readDirectory(workspaceId, {
            ...walkOptions,
            includeFiles: true,
            includeDirectories: false,
          }),
          platformAdapter.fs.readDirectory(workspaceId, {
            ...walkOptions,
            includeFiles: false,
            includeDirectories: true,
          }),
        ]);

        for (const result of [filesResult, dirsResult]) {
          if (!result.ok) {
            // Rethrow typed so WorkspaceErrorBoundary can recognize
            // permission failures and render the recovery fallback instead
            // of DebugPanel.
            const { type, path, message } = result.error;
            throw new FsError(type, path, message);
          }
        }
        if (!filesResult.ok || !dirsResult.ok) return []; // narrowing only

        const entries: { path: string; type: "file" | "directory" }[] = [
          ...dirsResult.value.map((p) => ({
            path: p,
            type: "directory" as const,
          })),
          ...filesResult.value.map((p) => ({ path: p, type: "file" as const })),
        ];
        scratchpadDebug(
          "metadata walk:",
          entries
            .filter((e) => e.path.includes("/.metrists"))
            .map((e) => e.path),
        );

        // Re-stat children of hydrated directories so their stats stay
        // fresh across refetches instead of pinning to hydration time.
        const hydrated = hydratedDirsFor(workspaceId);
        const pathsToStat = entries
          .filter((e) => hydrated.has(parentDirectory(e.path)))
          .map((e) => e.path);
        const statMap = new Map<string, { modifiedAt: Date; size: number }>();
        if (pathsToStat.length > 0) {
          const statResult = await platformAdapter.fs.getMetadata(pathsToStat);
          for (const m of statResult.succeeded) {
            statMap.set(m.path, { modifiedAt: m.modifiedAt, size: m.size });
          }
        }

        // Merge, don't wipe: full-replace sync would erase hydrated stats
        // and self-write bookkeeping for rows the walk still sees.
        const previousRows =
          workspaceCollectionsRegistry.get(workspaceId)?.metadata;

        return entries.map(({ path, type }) => {
          const stat = statMap.get(path);
          const previous = previousRows?.get(path);
          return {
            path,
            relativePath: relativeTreePath(workspaceId, path),
            type,
            modified: stat?.modifiedAt ?? previous?.modified,
            size: stat?.size ?? previous?.size,
            contentHash: previous?.contentHash ?? "",
          };
        });
      },

      getKey: (item) => item.path,

      onInsert: async ({ transaction }) => {
        const files = transaction.mutations
          .filter((m) => m.modified.type === "file")
          .map((m) => m.modified.path);

        const directories = transaction.mutations
          .filter((m) => m.modified.type === "directory")
          .map((m) => m.modified.path);

        if (files.length > 0) {
          const result = await platformAdapter.fs.createFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to create files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result =
            await platformAdapter.fs.createDirectories(directories);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to create directories: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }
      },

      onUpdate: async ({ transaction, collection }) => {
        let hasRename = false;
        for (const mutation of transaction.mutations) {
          const oldPath = String(mutation.key);
          const newPath = mutation.modified.path;

          if (oldPath !== newPath) {
            hasRename = true;
            const original = mutation.original;
            if (original.type === "file") {
              const moveResult = await platformAdapter.fs.moveFile(
                oldPath,
                newPath,
              );
              if (!moveResult.ok) {
                throw new Error(
                  `Failed to move file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
                );
              }
            } else {
              const moveResult = await platformAdapter.fs.moveDirectory(
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
        const files = transaction.mutations
          .filter((m) => m.original.type === "file")
          .map((m) => String(m.key));

        const directories = transaction.mutations
          .filter((m) => m.original.type === "directory")
          .map((m) => String(m.key));

        if (files.length > 0) {
          const result = await platformAdapter.fs.deleteFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to delete files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result = await platformAdapter.fs.deleteDirectories(
            directories,
            {
              recursive: true,
            },
          );
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

        const pathFilters = parsed.filters.filter(
          (f) =>
            f.field.join(".") === "path" &&
            (f.operator === "eq" || f.operator === "in"),
        );

        const requestedPaths = pathFilters.flatMap((f) =>
          Array.isArray(f.value) ? f.value : [f.value],
        );

        if (requestedPaths.length === 0) return [];

        if (requestedPaths.some((p) => p.includes("/.metrists/"))) {
          scratchpadDebug("content queryFn: reading", requestedPaths);
        }
        const result = await platformAdapter.fs.readFiles(requestedPaths);
        if (result.failed.length > 0) {
          scratchpadDebug("content queryFn: FAILED reads", result.failed);
        }

        const contentMap = new Map<string, FileContent>();

        for (const file of result.succeeded) {
          contentMap.set(file.path, {
            path: file.path,
            content: file.content,
            contentHash: calculateContentHash(file.content),
          });
        }

        // Add empty entries for UNREADABLE files (binary, permissions).
        // The error field marks that content is not the file's real
        // content, so the editor must never mount from (or save over) the
        // entry. A not_found is different: the file does not exist, so no
        // row may be fabricated — a delete racing a recreate of the same
        // path (scratchpad sweep, MET-135) would otherwise persist a
        // poisoned error row that the recreated file's editor then trusts.
        for (const failure of result.failed) {
          console.warn(
            `Failed to read file ${failure.path}: ${failure.message}`,
          );
          if (failure.type === "not_found") continue;
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

        const result = await platformAdapter.fs.writeFiles(files);
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

      onInsert: async ({ transaction, collection }) => {
        const files = transaction.mutations.map((m) => ({
          path: m.modified.path,
          content: m.modified.content,
        }));

        const result = await platformAdapter.fs.writeFiles(files);
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

export interface WorkspaceCollections {
  metadata: ReturnType<typeof createFileMetadataCollection>;
  content: ReturnType<typeof createFileContentCollection>;
}

const workspaceCollectionsRegistry = new Map<string, WorkspaceCollections>();

// ---------------------------------------------------------------------------
// Lazy stat hydration. Rows enter the collection from the listing walk with
// no modified/size; a directory's children get stat'd when the tree shows
// it. The hydrated set feeds the queryFn's re-stat on refetch.
// ---------------------------------------------------------------------------

const hydratedDirsRegistry = new Map<string, Set<string>>();
const hydrationInFlight = new Map<string, Promise<void>>();

function hydratedDirsFor(workspaceId: string): Set<string> {
  let dirs = hydratedDirsRegistry.get(workspaceId);
  if (!dirs) {
    dirs = new Set();
    hydratedDirsRegistry.set(workspaceId, dirs);
  }
  return dirs;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : "/";
}

/** Drop hydration bookkeeping for a directory subtree (delete/rename). */
function pruneHydratedDirs(workspaceId: string, path: string): void {
  const dirs = hydratedDirsRegistry.get(workspaceId);
  if (!dirs) return;
  const prefix = path.endsWith("/") ? path : path + "/";
  for (const dir of dirs) {
    if (dir === path || dir.startsWith(prefix)) {
      dirs.delete(dir);
    }
  }
}

/**
 * Stat a directory's direct children and write modified/size into their
 * rows. Callers re-invoke freely (tree expand, child-count changes) — one
 * stat batch per directory is cheap, concurrent calls per directory
 * coalesce, and rows the collection doesn't hold yet are simply picked up
 * by a later call or the periodic refetch's hydrated-dir re-stat.
 */
export function hydrateDirectoryStats(
  workspaceId: string,
  dirPath: string,
): Promise<void> {
  const key = `${workspaceId} ${dirPath}`;
  const inFlight = hydrationInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const collections = workspaceCollectionsRegistry.get(workspaceId);
    if (!collections) return;

    const children = collections.metadata.toArray.filter((row) => {
      const rel = relativeTreePath(dirPath, row.path);
      return rel !== undefined && rel !== "" && !rel.includes("/");
    });

    if (children.length > 0) {
      const result = await platformAdapter.fs.getMetadata(
        children.map((c) => c.path),
      );
      const updates: FileMetadata[] = [];
      for (const m of result.succeeded) {
        const row = collections.metadata.get(m.path);
        if (!row) continue;
        updates.push({ ...row, modified: m.modifiedAt, size: m.size });
      }
      if (updates.length > 0) {
        collections.metadata.utils.writeUpsert(updates);
      }
    }

    hydratedDirsFor(workspaceId).add(dirPath);
  })().finally(() => {
    hydrationInFlight.delete(key);
  });

  hydrationInFlight.set(key, promise);
  return promise;
}

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
 * Sync the content row (and metadata contentHash) for `path` to `content`.
 * The single implementation of "a loaded file's row reflects its bytes":
 * called after app writes that bypass this entity's own write path
 * (writeWorkspaceTextFile — the agent/blob primitive, whose watcher echo is
 * consumed natively, so nothing else would bring the row forward and
 * adoption would later roll the editor back to the stale row) and by the
 * watcher handler after it verifies an external change against disk. Rows
 * exist only for loaded files; unloaded paths are a no-op, and callers have
 * no workspace handle, so the (tiny) registry is scanned for the owning
 * row. The hash is computed lazily — most agent writes target files no
 * workspace has loaded.
 */
export function updateLoadedContentRow(path: string, content: string): void {
  let contentHash: string | undefined;
  for (const collections of workspaceCollectionsRegistry.values()) {
    const existing = collections.content.get(path);
    if (!existing) continue;
    contentHash ??= calculateContentHash(content);
    if (existing.contentHash === contentHash) continue;

    collections.content.utils.writeUpdate({ path, content, contentHash });

    const existingMetadata = collections.metadata.get(path);
    if (existingMetadata && existingMetadata.contentHash !== contentHash) {
      collections.metadata.utils.writeUpdate({
        ...existingMetadata,
        contentHash,
      });
    }
  }
}

/** Refetch the metadata collection; call when files are known to have changed on disk. */
export async function refreshDirectoryMetadata(
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);
  await collections.metadata.utils.refetch();
}

export async function writeFileContent(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);
  const contentHash = calculateContentHash(content);

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

  const metadataResult = await platformAdapter.fs.getMetadata([filePath]);
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

export async function createFile(
  workspaceId: string,
  filePath: string,
  content: string = "",
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  const tx = collections.metadata.insert({
    path: filePath,
    relativePath: relativeTreePath(workspaceId, filePath),
    type: "file",
    contentHash: "",
    size: 0,
  });
  // The mutation handler writes the file asynchronously; callers open the
  // path as a tab immediately after, and the content load must not race
  // the disk write (a lost race is a sticky not_found editor — the write's
  // own watcher echo is suppressed, so nothing would heal it).
  await tx.isPersisted.promise;

  // A fresh file must not inherit a content row from a previous life of
  // this path (e.g. an error row left by a read that raced its deletion).
  if (collections.content.get(filePath)) {
    collections.content.utils.writeDelete(filePath);
  }

  if (content) {
    await writeFileContent(workspaceId, filePath, content);
  }

  // Refresh metadata to get accurate timestamps
  const metadataResult = await platformAdapter.fs.getMetadata([filePath]);
  if (
    metadataResult.succeeded.length > 0 &&
    collections.metadata.get(filePath)
  ) {
    const metadata = metadataResult.succeeded[0];
    collections.metadata.update(filePath, (draft) => {
      draft.modified = metadata.modifiedAt;
      draft.size = metadata.size;
    });
  }
}

export async function createDirectory(
  workspaceId: string,
  dirPath: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  collections.metadata.insert({
    path: dirPath,
    relativePath: relativeTreePath(workspaceId, dirPath),
    type: "directory",
    contentHash: "",
  });

  // Refresh metadata to get accurate timestamps
  const metadataResult = await platformAdapter.fs.getMetadata([dirPath]);
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
 *   platformAdapter.fs.deleteDirectories with recursive: true
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
    const allMetadata = collections.metadata.toArray;

    for (const child of allMetadata) {
      const rel = relativeTreePath(path, child.path);
      if (rel !== undefined && rel !== "") {
        const childContent = collections.content.get(child.path);
        if (childContent) {
          collections.content.utils.writeDelete(child.path);
        }
        collections.metadata.utils.writeDelete(child.path);
      }
    }
  }

  collections.metadata.delete(path);
  pruneHydratedDirs(workspaceId, path);

  const content = collections.content.get(path);
  if (content) {
    collections.content.delete(path);
  }
}

/** A full FileEntry joining metadata and content; null if not found. */
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

/** Pre-load file content into the collection cache (e.g. hover prefetch). */
export async function prefetchFileContent(
  workspaceId: string,
  filePath: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  const existingContent = collections.content.get(filePath);
  if (existingContent) {
    return;
  }

  const result = await platformAdapter.fs.readFiles([filePath]);

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
      if (error instanceof Error && error.name === "SyncNotInitializedError") {
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

  const existing = collections.metadata.get(newPath);
  if (existing) {
    throw new Error(
      `Cannot rename: a file or directory already exists at ${newPath}`,
    );
  }

  const computeRelativePath = (absolutePath: string): string | undefined =>
    relativeTreePath(workspaceId, absolutePath);

  if (entry.type === "file") {
    const moveResult = await platformAdapter.fs.moveFile(oldPath, newPath);
    if (!moveResult.ok) {
      throw new Error(
        `Failed to rename file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
      );
    }

    collections.metadata.utils.writeDelete(oldPath);
    collections.metadata.utils.writeInsert({
      ...entry,
      path: newPath,
      relativePath: computeRelativePath(newPath),
    });

    const contentEntry = collections.content.get(oldPath);
    if (contentEntry) {
      collections.content.utils.writeDelete(oldPath);
      collections.content.utils.writeInsert({
        ...contentEntry,
        path: newPath,
      });
    }
  } else {
    const moveResult = await platformAdapter.fs.moveDirectory(oldPath, newPath);
    if (!moveResult.ok) {
      throw new Error(
        `Failed to rename directory ${oldPath} to ${newPath}: ${moveResult.error.message}`,
      );
    }

    const allMetadata = collections.metadata.toArray;

    for (const child of allMetadata) {
      const rel = relativeTreePath(oldPath, child.path);
      if (rel !== undefined && rel !== "") {
        const newChildPath = pathutil.join(newPath, pathutil.fromTreePath(rel));

        collections.metadata.utils.writeDelete(child.path);
        collections.metadata.utils.writeInsert({
          ...child,
          path: newChildPath,
          relativePath: computeRelativePath(newChildPath),
        });

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

    collections.metadata.utils.writeDelete(oldPath);
    collections.metadata.utils.writeInsert({
      ...entry,
      path: newPath,
      relativePath: computeRelativePath(newPath),
    });
    // Hydration state keys on paths; the renamed subtree re-hydrates when
    // the tree shows it again.
    pruneHydratedDirs(workspaceId, oldPath);
  }
}

export function clearWorkspaceCollections(workspaceId: string): void {
  workspaceCollectionsRegistry.delete(workspaceId);
  hydratedDirsRegistry.delete(workspaceId);
  // Drop cached query state too, so a fresh open refetches instead of
  // replaying a stale error or stale data.
  queryClient.removeQueries({ queryKey: ["file-metadata", workspaceId] });
  queryClient.removeQueries({ queryKey: ["file-content", workspaceId] });
}

/** The workspace's collections as a render-stable pair. */
export function useFileCollections(
  workspacePath: string,
): WorkspaceCollections {
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
            // The callback runs once at build time with ref PROXIES, not
            // per row — plain JS operators on them constant-fold. The old
            // `content !== undefined` compiled to a hardcoded `true` and
            // `?? ""` to a no-op, so rows claimed loaded content while the
            // join was still empty (undefined). Everything data-dependent
            // must go through query operators.
            .select(({ file, content }) => ({
              ...file,
              content: coalesce(content?.content, ""),
              contentHash: coalesce(content?.contentHash, ""),
              isContentLoaded: not(isUndefined(content?.content)),
              contentError: content?.error,
            })),
    [workspacePath, ...paths],
  );
  return data as OpenFileRow[];
}

/** Re-walk the workspace's metadata after out-of-band disk mutations
 * (e.g. the entry-time scratchpad sweep, which runs on plain adapter fs).
 * No-op when the workspace's collection hasn't mounted yet — the initial
 * walk will see the files. */
export function refetchWorkspaceMetadata(workspacePath: string): Promise<void> {
  return queryClient.refetchQueries({
    queryKey: ["file-metadata", workspacePath],
  });
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
