/**
 * Files entity — each open workspace's files, as the files module's
 * workspace instance (`core.workspace(ws).files`).
 *
 * Two TanStack DB collections per workspace:
 * 1. Metadata — every entry's type, size, modified, hash; NOT content.
 *    Loads eagerly (the listing walk), so the tree shows at once.
 * 2. Content — path + content only, loaded on demand when a query asks for
 *    a path (an open tab).
 *
 * The split keeps the tree fast without reading every file. Both are
 * TanStack Query collections over the platform's fs: the fs (local or
 * remote) is the source we query, mutations write back through it, and
 * Query gives us loading and error state and retries.
 *
 * Everything a workspace's files need — the fs, the query client — is
 * handed to `createWorkspaceFiles` by core; nothing here imports the
 * platform. The instance also owns its metadata and content watchers, and
 * the debounced invalidation every write shares.
 */
import { useEffect, useMemo } from "react";
import { defineModule } from "@notefig/core";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import {
  createCollection,
  useLiveQuery,
  eq,
  inArray,
  coalesce,
  isUndefined,
  not,
} from "@tanstack/react-db";
import { useIsFetching, type QueryClient } from "@tanstack/react-query";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
import {
  FsError,
  isWorkspaceAccessError,
  type FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import type { FileEntry } from "@/utils/fs";
import { IGNORE_RULES } from "@/utils/ignore";
import { calculateContentHash } from "@/utils/hash";
import { emitAppEvent } from "@/utils/app-events";
import { path as pathutil, relativeTreePath, workspaceKey } from "@/utils/path";
import {
  startContentWatcher,
  startMetadataWatcher,
  type ContentWatcher,
  type MetadataWatcher,
} from "@/utils/file-sync";

const METADATA_REFETCH_INTERVAL_MS = 30_000;
const INVALIDATE_DEBOUNCE_MS = 500;

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

/** What a workspace's files are built from. */
export interface FilesDeps {
  workspacePath: string;
  fs: FileSystemSurface;
  queryClient: QueryClient;
}

/** The query keys a workspace's collections live under — also what the
 *  fetching hooks watch. */
export const fileQueryKeys = {
  metadata: (workspacePath: string) => ["file-metadata", workspacePath],
  content: (workspacePath: string) => ["file-content", workspacePath],
};

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : "/";
}

function createMetadataCollection(
  { workspacePath, fs, queryClient }: FilesDeps,
  hydratedDirs: Set<string>,
  current: () => MetadataCollection | undefined,
) {
  return createCollection(
    queryCollectionOptions<FileMetadata, string>({
      queryKey: fileQueryKeys.metadata(workspacePath),
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
      // 30s cycle stays cheap on large workspaces. One walk: the listing
      // carries entry types.
      queryFn: async (): Promise<FileMetadata[]> => {
        const listing = await fs.readDirectory(workspacePath, {
          recursive: true,
          ignore: IGNORE_RULES,
          includeFiles: true,
          includeDirectories: true,
        });

        if (!listing.ok) {
          // Rethrow typed so WorkspaceErrorBoundary can recognize
          // permission failures and render the recovery fallback instead
          // of DebugPanel.
          const { type, path, message } = listing.error;
          throw new FsError(type, path, message);
        }

        // Directories first, matching the old dirs-then-files ordering.
        const entries = [
          ...listing.value.filter((e) => e.type === "directory"),
          ...listing.value.filter((e) => e.type === "file"),
        ];
        scratchpadDebug(
          "metadata walk:",
          entries
            .filter((e) => e.path.includes("/.metrists"))
            .map((e) => e.path),
        );

        // Re-stat children of hydrated directories so their stats stay
        // fresh across refetches instead of pinning to hydration time.
        const pathsToStat = entries
          .filter((e) => hydratedDirs.has(parentDirectory(e.path)))
          .map((e) => e.path);
        const statMap = new Map<string, { modifiedAt: Date; size: number }>();
        if (pathsToStat.length > 0) {
          const statResult = await fs.getMetadata(pathsToStat);
          for (const m of statResult.succeeded) {
            statMap.set(m.path, { modifiedAt: m.modifiedAt, size: m.size });
          }
        }

        // Merge, don't wipe: full-replace sync would erase hydrated stats
        // and self-write bookkeeping for rows the walk still sees.
        const previousRows = current();

        return entries.map(({ path, type }) => {
          const stat = statMap.get(path);
          const previous = previousRows?.get(path);
          return {
            path,
            relativePath: relativeTreePath(workspacePath, path),
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
          const result = await fs.createFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to create files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result = await fs.createDirectories(directories);
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
              const moveResult = await fs.moveFile(oldPath, newPath);
              if (!moveResult.ok) {
                throw new Error(
                  `Failed to move file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
                );
              }
            } else {
              const moveResult = await fs.moveDirectory(oldPath, newPath);
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
          const result = await fs.deleteFiles(files);
          if (result.failed.length > 0) {
            throw new Error(
              `Failed to delete files: ${result.failed.map((f) => f.message).join(", ")}`,
            );
          }
        }

        if (directories.length > 0) {
          const result = await fs.deleteDirectories(directories, {
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
 * The content collection: one row per loaded file, on demand. A query with
 * a where clause on `path` makes TanStack DB call the queryFn with those
 * paths (parseLoadSubsetOptions), and only they are read:
 *
 * ```ts
 * q.from({ content })
 *   .where(({ content }) => inArray(content.path, ['/path/to/file.md']))
 * ```
 */
function createContentCollection(
  { workspacePath, fs, queryClient }: FilesDeps,
  refetchMetadata: () => Promise<void>,
) {
  return createCollection(
    queryCollectionOptions<FileContent>({
      queryKey: fileQueryKeys.content(workspacePath),
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
        const result = await fs.readFiles(requestedPaths);
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
        // A not_found read is disk truth the listing has not caught up
        // with (an external delete): re-walk, so the tree and the file's
        // tab go away instead of sitting on a placeholder until the next
        // interval walk.
        if (result.failed.some((failure) => failure.type === "not_found")) {
          void refetchMetadata();
        }
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

        const result = await fs.writeFiles(files);
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

        const result = await fs.writeFiles(files);
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

type MetadataCollection = ReturnType<typeof createMetadataCollection>;
type ContentCollection = ReturnType<typeof createContentCollection>;

export interface WorkspaceCollections {
  metadata: MetadataCollection;
  content: ContentCollection;
}

// ---------------------------------------------------------------------------
// The instance
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
  /** Create it as a file (empty unless `content` is given). */
  create(content?: string): Promise<void>;
  /** Create it as a directory. */
  createDirectory(): Promise<void>;
  /** Replace the file's content on disk; resolves once it is written. */
  write(content: string): Promise<void>;
  /** Move it (file or directory) to `newPath`, inside the same workspace. */
  rename(newPath: string): Promise<void>;
  /** Delete it; a directory goes with everything under it. */
  delete(): Promise<void>;
  /** Metadata and loaded content joined; null if there is no such entry. */
  entry(): FileEntry | null;
  /** Load its content into the cache ahead of use (hover prefetch). */
  prefetch(): Promise<void>;
}

/** One open workspace's files — `core.workspace(ws).files`. */
export interface WorkspaceFiles {
  readonly workspacePath: string;
  readonly collections: WorkspaceCollections;
  file(filePath: string): FileHandle;
  /** Refetch the listing; call when files are known to have changed. */
  refresh(): Promise<void>;
  /**
   * Re-walk after out-of-band disk mutations (the entry-time scratchpad
   * sweep). Resolves once a walk that STARTED after this call has landed: a
   * walk already in flight may predate the mutation, so it finishes and a
   * fresh one follows.
   */
  refetchMetadata(): Promise<void>;
  /**
   * Stat a directory's direct children and write modified/size into their
   * rows. Callers re-invoke freely (tree expand, child-count changes) — one
   * stat batch per directory is cheap, concurrent calls per directory
   * coalesce, and rows the collection doesn't hold yet are picked up by a
   * later call or the periodic refetch's hydrated-dir re-stat.
   */
  hydrateDirectoryStats(dirPath: string): Promise<void>;
  /**
   * Bring a loaded file's rows (content, and metadata's hash) to `content`.
   * The one implementation of "a loaded file's row reflects its bytes",
   * for writes that bypass this instance's own (the agent's adopting write)
   * and for the watcher after it verified a change against disk. No-op for
   * a path with no content row.
   */
  updateLoadedContent(path: string, content: string): void;
  /** Search results and git rows go stale (debounced): a write the
   *  watcher suppresses, or a change the watcher reported. */
  invalidateDerived(): void;
  /** Watch content of these open files (replacing the previous set; an
   *  empty set stops the content watch). */
  watchContent(paths: string[]): void;
  /** Give a metadata watcher whose start failed another chance (the
   *  folder was unreadable when it opened). */
  ensureWatching(): void;
  /** Drop and re-seed the file state (error-boundary recovery after fs
   *  access is restored); agents and the watcher are untouched. */
  reload(): void;
  /** Stop the watchers, drop cached queries and pending invalidation. */
  dispose(): void;
}

export function createWorkspaceFiles(deps: FilesDeps): WorkspaceFiles {
  const { workspacePath, fs, queryClient } = deps;
  /** Directories whose children have been stat'd: the queryFn re-stats
   *  them on every refetch. */
  const hydratedDirs = new Set<string>();
  const hydrationInFlight = new Map<string, Promise<void>>();
  let invalidationTimer: ReturnType<typeof setTimeout> | null = null;

  const refetchMetadata = async () => {
    const queryKey = fileQueryKeys.metadata(workspacePath);
    if (queryClient.isFetching({ queryKey }) > 0) {
      await queryClient.refetchQueries({ queryKey }, { cancelRefetch: false });
    }
    await queryClient.refetchQueries({ queryKey }, { cancelRefetch: false });
  };

  const seed = (): WorkspaceCollections => ({
    metadata: createMetadataCollection(
      deps,
      hydratedDirs,
      () => collections.metadata,
    ),
    content: createContentCollection(deps, refetchMetadata),
  });
  let collections: WorkspaceCollections = seed();

  /** Drop hydration bookkeeping for a directory subtree (delete/rename). */
  const pruneHydratedDirs = (path: string) => {
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const dir of hydratedDirs) {
      if (dir === path || dir.startsWith(prefix)) hydratedDirs.delete(dir);
    }
  };

  const invalidateDerived = () => {
    if (invalidationTimer) clearTimeout(invalidationTimer);
    invalidationTimer = setTimeout(() => {
      invalidationTimer = null;
      void queryClient.invalidateQueries({
        queryKey: ["search-content", workspacePath],
      });
      emitAppEvent("git:stale", { workspacePath });
    }, INVALIDATE_DEBOUNCE_MS);
  };

  const updateLoadedContent = (path: string, content: string) => {
    const existing = collections.content.get(path);
    if (!existing) return;
    const contentHash = calculateContentHash(content);
    if (existing.contentHash === contentHash) return;

    collections.content.utils.writeUpdate({ path, content, contentHash });

    const existingMetadata = collections.metadata.get(path);
    if (existingMetadata && existingMetadata.contentHash !== contentHash) {
      collections.metadata.utils.writeUpdate({
        ...existingMetadata,
        contentHash,
      });
    }
  };

  const restat = async (path: string) =>
    (await fs.getMetadata([path])).succeeded[0];

  const write = async (filePath: string, content: string) => {
    const contentHash = calculateContentHash(content);

    const existingContent = collections.content.get(filePath);
    const tx = existingContent
      ? collections.content.update(filePath, (draft) => {
          draft.content = content;
          draft.contentHash = contentHash;
        })
      : collections.content.insert({ path: filePath, content, contentHash });

    // The disk write happens asynchronously in the mutation handler; reading
    // metadata before it lands would capture the pre-write mtime and make
    // date-sorted views flap between old and new positions.
    await tx.isPersisted.promise;

    const metadata = await restat(filePath);
    if (metadata && collections.metadata.get(filePath)) {
      collections.metadata.update(filePath, (draft) => {
        draft.modified = metadata.modifiedAt;
        draft.size = metadata.size;
        draft.contentHash = contentHash;
      });
    }

    // App self-writes are suppressed by the fs watcher, so derived state
    // (git status, search) must be invalidated here.
    invalidateDerived();
  };

  const createFile = async (filePath: string, content = "") => {
    const tx = collections.metadata.insert({
      path: filePath,
      relativePath: relativeTreePath(workspacePath, filePath),
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

    if (content) await write(filePath, content);

    // Refresh metadata to get accurate timestamps
    const metadata = await restat(filePath);
    if (metadata && collections.metadata.get(filePath)) {
      collections.metadata.update(filePath, (draft) => {
        draft.modified = metadata.modifiedAt;
        draft.size = metadata.size;
      });
    }
  };

  const createDirectory = async (dirPath: string) => {
    collections.metadata.insert({
      path: dirPath,
      relativePath: relativeTreePath(workspacePath, dirPath),
      type: "directory",
      contentHash: "",
    });

    // Refresh metadata to get accurate timestamps
    const metadata = await restat(dirPath);
    if (metadata) {
      collections.metadata.update(dirPath, (draft) => {
        draft.modified = metadata.modifiedAt;
        draft.size = metadata.size;
      });
    }
  };

  /**
   * For a directory, the children leave the collections by direct write
   * first (the recursive fs delete removes them on disk); the entry itself
   * goes through the mutation handler, which deletes recursively.
   */
  const remove = async (path: string) => {
    const entry = collections.metadata.get(path);

    if (entry?.type === "directory") {
      for (const child of collections.metadata.toArray) {
        const rel = relativeTreePath(path, child.path);
        if (rel !== undefined && rel !== "") {
          if (collections.content.get(child.path)) {
            collections.content.utils.writeDelete(child.path);
          }
          collections.metadata.utils.writeDelete(child.path);
        }
      }
    }

    collections.metadata.delete(path);
    pruneHydratedDirs(path);

    if (collections.content.get(path)) {
      collections.content.delete(path);
    }
  };

  /**
   * Move a file or directory on disk, then re-key its rows (and, for a
   * directory, every descendant's) by direct write — the fs operation is
   * done here, not by a mutation handler.
   */
  const rename = async (oldPath: string, newPath: string) => {
    if (oldPath === newPath) return;

    const entry = collections.metadata.get(oldPath);
    if (!entry) {
      throw new Error(`Cannot rename: no metadata entry found for ${oldPath}`);
    }
    if (collections.metadata.get(newPath)) {
      throw new Error(
        `Cannot rename: a file or directory already exists at ${newPath}`,
      );
    }

    const relativeOf = (absolutePath: string) =>
      relativeTreePath(workspacePath, absolutePath);

    if (entry.type === "file") {
      const moveResult = await fs.moveFile(oldPath, newPath);
      if (!moveResult.ok) {
        throw new Error(
          `Failed to rename file ${oldPath} to ${newPath}: ${moveResult.error.message}`,
        );
      }

      collections.metadata.utils.writeDelete(oldPath);
      collections.metadata.utils.writeInsert({
        ...entry,
        path: newPath,
        relativePath: relativeOf(newPath),
      });

      const contentEntry = collections.content.get(oldPath);
      if (contentEntry) {
        collections.content.utils.writeDelete(oldPath);
        collections.content.utils.writeInsert({
          ...contentEntry,
          path: newPath,
        });
      }
      return;
    }

    const moveResult = await fs.moveDirectory(oldPath, newPath);
    if (!moveResult.ok) {
      throw new Error(
        `Failed to rename directory ${oldPath} to ${newPath}: ${moveResult.error.message}`,
      );
    }

    for (const child of collections.metadata.toArray) {
      const rel = relativeTreePath(oldPath, child.path);
      if (rel !== undefined && rel !== "") {
        const newChildPath = pathutil.join(newPath, pathutil.fromTreePath(rel));

        collections.metadata.utils.writeDelete(child.path);
        collections.metadata.utils.writeInsert({
          ...child,
          path: newChildPath,
          relativePath: relativeOf(newChildPath),
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
      relativePath: relativeOf(newPath),
    });
    // Hydration state keys on paths; the renamed subtree re-hydrates when
    // the tree shows it again.
    pruneHydratedDirs(oldPath);
  };

  const entry = (filePath: string): FileEntry | null => {
    const metadata = collections.metadata.get(filePath);
    const content = collections.content.get(filePath);
    if (!metadata) return null;
    return {
      path: metadata.path,
      relativePath: metadata.relativePath,
      type: metadata.type,
      modified: metadata.modified,
      size: metadata.size,
      // content and its hash must come from the same row — the content
      // collection hashes the exact string it holds.
      contentHash: content?.contentHash || metadata.contentHash,
      content: content?.content || "",
      error: metadata.error,
    };
  };

  const prefetch = async (filePath: string) => {
    if (collections.content.get(filePath)) return;

    const result = await fs.readFiles([filePath]);
    const file = result.succeeded[0];
    if (!file) return;
    try {
      collections.content.utils.writeInsert({
        path: file.path,
        content: file.content,
        contentHash: calculateContentHash(file.content),
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
  };

  const hydrateDirectoryStats = (dirPath: string) => {
    const inFlight = hydrationInFlight.get(dirPath);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const children = collections.metadata.toArray.filter((row) => {
        const rel = relativeTreePath(dirPath, row.path);
        return rel !== undefined && rel !== "" && !rel.includes("/");
      });

      if (children.length > 0) {
        const result = await fs.getMetadata(children.map((c) => c.path));
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

      hydratedDirs.add(dirPath);
    })().finally(() => {
      hydrationInFlight.delete(dirPath);
    });

    hydrationInFlight.set(dirPath, promise);
    return promise;
  };

  const dropQueries = () => {
    queryClient.removeQueries({
      queryKey: fileQueryKeys.metadata(workspacePath),
    });
    queryClient.removeQueries({
      queryKey: fileQueryKeys.content(workspacePath),
    });
  };

  const files: WorkspaceFiles = {
    workspacePath,
    get collections() {
      return collections;
    },
    file: (filePath) => ({
      workspacePath,
      filePath,
      exists: () => collections.metadata.get(filePath) !== undefined,
      metadata: () => collections.metadata.get(filePath),
      content: () => collections.content.get(filePath)?.content,
      create: (content) => createFile(filePath, content),
      createDirectory: () => createDirectory(filePath),
      write: (content) => write(filePath, content),
      rename: (newPath) => rename(filePath, newPath),
      delete: () => remove(filePath),
      entry: () => entry(filePath),
      prefetch: () => prefetch(filePath),
    }),
    refresh: async () => {
      await collections.metadata.utils.refetch();
    },
    refetchMetadata,
    hydrateDirectoryStats,
    updateLoadedContent,
    invalidateDerived,
    watchContent: (paths) => {
      if (paths.length === 0) {
        contentWatcher?.stop();
        contentWatcher = null;
      } else if (!contentWatcher) {
        contentWatcher = startContentWatcher(files, fs, paths);
      } else if (paths.join(",") !== contentWatcher.pathsKey) {
        contentWatcher.setPaths(paths);
      }
    },
    ensureWatching: () => metadataWatcher.ensureStarted(),
    reload: () => {
      hydratedDirs.clear();
      dropQueries();
      collections = seed();
      void files.refresh();
    },
    dispose: () => {
      metadataWatcher.stop();
      contentWatcher?.stop();
      contentWatcher = null;
      if (invalidationTimer) clearTimeout(invalidationTimer);
      invalidationTimer = null;
      // Drop cached query state too, so a fresh open refetches instead of
      // replaying a stale error or stale data.
      dropQueries();
    },
  };

  // Watched from open to close, so a backgrounded workspace keeps taking in
  // external changes (MET-177). Content watching follows the open tabs.
  const metadataWatcher: MetadataWatcher = startMetadataWatcher(files, fs);
  let contentWatcher: ContentWatcher | null = null;
  // The listing walk starts with the workspace, not with the first reader.
  void collections.metadata.preload();

  return files;
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    files: WorkspaceFiles;
  }
}

export const filesModule = defineModule({
  name: "files",
  needs: ["platform", "queryClient"],
  // Coming back to a workspace re-stats its listing (cheap, catches
  // watcher gaps) and gives a watcher whose start failed another chance.
  boot: (_api, ctx) =>
    ctx.hooks.on("workspace:focused", ({ path }) => {
      // An earlier focus step can still be waiting when the workspace
      // closes; closing drops it from the open set before teardown, so
      // this also skips one whose instances are being disposed.
      const workspace = ctx.workspaceHandle(path);
      if (!workspace.isOpen()) return;
      const { files } = workspace;
      files.ensureWatching();
      void files.refresh();
    }),
  workspace: {
    create: (ctx) =>
      createWorkspaceFiles({
        workspacePath: pathutil.normalize(ctx.workspace.path),
        fs: ctx.use("platform").fs,
        queryClient: ctx.use("queryClient"),
      }),
    dispose: (files) => files.dispose(),
  },
});

// ---------------------------------------------------------------------------
// Reading the rows from React
// ---------------------------------------------------------------------------

/** The workspace's collections while it is open (render-stable). */
export function useFileCollections(
  workspacePath: string | null | undefined,
): WorkspaceCollections | undefined {
  return useWorkspaceModule(workspacePath, "files")?.collections;
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
 * A null workspace (the path is in no open workspace) yields no rows.
 */
export function useOpenFileRows(
  workspacePath: string | null,
  paths: string[],
): OpenFileRow[] {
  const collections = useFileCollections(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      collections === undefined || paths.length === 0
        ? undefined
        : q
            .from({ file: collections.metadata })
            .where(({ file }) => inArray(file.path, paths))
            .leftJoin({ content: collections.content }, ({ file, content }) =>
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
    [collections, ...paths],
  );
  return data as OpenFileRow[];
}

/** Whether a load is in flight for one of the query kinds — the
 *  workspace's, or any open workspace's when no path is given (the dock
 *  spans them all). */
function useFilesFetching(
  kind: "file-metadata" | "file-content",
  workspacePath?: string,
): boolean {
  const queryClient = useCore().use("queryClient");
  const queryKey = useMemo(
    () => (workspacePath === undefined ? [kind] : [kind, workspacePath]),
    [kind, workspacePath],
  );
  return useIsFetching({ queryKey }, queryClient) > 0;
}

/** Whether an eager metadata load is in flight. */
export function useMetadataFetching(workspacePath?: string): boolean {
  return useFilesFetching("file-metadata", workspacePath);
}

/** Whether an on-demand content load is in flight. */
export function useContentFetching(workspacePath?: string): boolean {
  return useFilesFetching("file-content", workspacePath);
}

/**
 * Keep each open workspace's content watch on its open file tabs
 * (`openFilesByWorkspace`: workspace → its open file paths). A workspace
 * with none stops watching content; every watch stops on unmount.
 */
export function useContentWatches(
  openFilesByWorkspace: Map<string, string[]>,
): void {
  const core = useCore();
  useEffect(() => {
    const byKey = new Map(
      [...openFilesByWorkspace].map(([path, paths]) => [
        workspaceKey(path),
        paths,
      ]),
    );
    const sync = () => {
      for (const workspace of core.workspaces.list()) {
        core
          .workspace(workspace.path)
          .files.watchContent(byKey.get(workspace.key) ?? []);
      }
    };
    sync();
    // A workspace core opens later gets its watch too.
    return core.workspaces.subscribe(sync);
  }, [core, openFilesByWorkspace]);
  useEffect(
    () => () => {
      for (const workspace of core.workspaces.list()) {
        core.workspace(workspace.path).files.watchContent([]);
      }
    },
    [core],
  );
}
