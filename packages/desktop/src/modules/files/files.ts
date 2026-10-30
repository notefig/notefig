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
 * The split keeps the tree fast without reading every file. Both read the
 * platform's fs through TanStack Query: the fs (local or remote) is the
 * source we query, mutations write back through it, and Query gives us
 * loading and error state and retries. Content is a query collection;
 * metadata syncs its rows from the walk itself (metadata-collection.ts).
 *
 * Everything a workspace's files need — the fs, the query client — is
 * handed to `createWorkspaceFiles` by core; nothing here imports the
 * platform. The instance also owns its metadata and content watchers, and
 * the debounced invalidation every write shares.
 */
import { defineModule, type Hooks } from "@notefig/core";
import {
  createCollection,
  eq,
  inArray,
  coalesce,
  not,
} from "@tanstack/react-db";
import { type QueryClient } from "@tanstack/react-query";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
import { type FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { FileEntry } from "@/utils/fs";
import { calculateContentHash } from "@/utils/hash";
import { path as pathutil, relativeTreePath } from "@/utils/path";
import {
  startContentWatcher,
  startMetadataWatcher,
  type ContentWatcher,
  type MetadataWatcher,
} from "@/modules/files/file-sync";
import { platformModule, queryClientModule } from "@/core/services";
import { createMetadataCollection } from "./metadata-collection";

const METADATA_REFETCH_INTERVAL_MS = 30_000;
/** How long a walked listing counts as current: returning to a workspace
 *  (its tree remounting, its focus) re-walks only an older one. */
const LISTING_FRESH_MS = 10_000;
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
  /** Where `files:changed` and `git:stale` are announced. */
  hooks: Pick<Hooks, "emit">;
}

declare module "@notefig/core" {
  interface CoreHookMap {
    /** The watcher reported changes in a workspace (created, deleted,
     *  renamed or rewritten paths), already applied to its file rows. For
     *  state derived from particular files (project settings). */
    "files:changed": { workspacePath: string; paths: string[] };
  }
}

/** The query keys a workspace's collections live under — also what the
 *  fetching hooks watch. */
export const fileQueryKeys = {
  metadata: (workspacePath: string) => ["file-metadata", workspacePath],
  content: (workspacePath: string) => ["file-content", workspacePath],
};

/** The directory holding `path`, in the app's path flavor (backslashes on
 *  Windows): the refetch's re-stat and the tree's hydration both match
 *  rows to directories by it. */
function parentDirectory(path: string): string {
  return pathutil.dirname(path);
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
  /** Replace the file's content on disk; resolves once it is written.
   *  `contentHash`: the content's, when the caller has it already (the
   *  autosave's serializer hashes off the main thread). */
  write(content: string, contentHash?: string): Promise<void>;
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
   * Re-walk unless a walk is in flight or landed within `maxAgeMs` — for
   * catching watcher gaps on a return, without a full walk (and a cancel
   * of the one running) on every switch.
   */
  catchUp(maxAgeMs: number): Promise<void>;
  /**
   * Re-walk after out-of-band disk mutations (the entry-time scratchpad
   * sweep). Resolves once a walk that STARTED after this call has landed: a
   * walk already in flight may predate the mutation, so it finishes and a
   * fresh one follows.
   */
  refetchMetadata(): Promise<void>;
  /**
   * The rows for disk changes this app made behind the collections' back
   * (the entry-time scratchpad sweep and landing), without a re-walk: at
   * 20k files the walk is most of an entry. A walk in flight may predate
   * the changes, so it lands first and the rows are written on top; every
   * later walk sees them on disk. A created file brings its missing
   * ancestor directories, as a walk would.
   */
  recordDiskChanges(changes: {
    created: readonly string[];
    deleted: readonly string[];
  }): Promise<void>;
  /**
   * Stat the direct children of these directories and write modified/size
   * into their rows — one stat batch and one write for all of them. Callers
   * re-invoke freely (tree expand, child-count changes): a hydrated
   * directory is skipped (the refetch re-stats its children), concurrent
   * calls per directory coalesce, and rows the collection doesn't hold yet
   * are picked up by a later call or the refetch.
   */
  hydrateDirectoryStats(dirPaths: readonly string[]): Promise<void>;
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
  /** The watcher reported these paths changed, and their rows are
   *  updated: announce `files:changed`, then the derived state goes stale. */
  changed(paths: string[]): void;
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
  const { workspacePath, fs, queryClient, hooks } = deps;
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

  const recordDiskChanges = async ({
    created,
    deleted,
  }: {
    created: readonly string[];
    deleted: readonly string[];
  }) => {
    const queryKey = fileQueryKeys.metadata(workspacePath);
    if (queryClient.isFetching({ queryKey }) > 0) {
      await queryClient.refetchQueries({ queryKey }, { cancelRefetch: false });
    }
    const { metadata, content } = collections;
    const missing = new Set<string>();
    for (const path of created) {
      for (
        let at = path;
        at !== workspacePath && !metadata.get(at) && !missing.has(at);
        at = parentDirectory(at)
      ) {
        if (relativeTreePath(workspacePath, at) === undefined) break;
        missing.add(at);
      }
    }
    const stats = missing.size > 0 ? await fs.getMetadata([...missing]) : null;
    // One transaction for all of them.
    metadata.utils.writeBatch(() => {
      for (const path of deleted) {
        if (metadata.get(path)) metadata.utils.writeDelete(path);
      }
      for (const stat of stats?.succeeded ?? []) {
        if (metadata.get(stat.path)) continue;
        metadata.utils.writeInsert({
          path: stat.path,
          relativePath: relativeTreePath(workspacePath, stat.path),
          type: stat.type,
          modified: stat.modifiedAt,
          size: stat.size,
          contentHash: "",
        });
      }
    });
    for (const path of deleted) {
      if (content.get(path)) content.utils.writeDelete(path);
    }
  };

  const seed = (): WorkspaceCollections => ({
    metadata: createMetadataCollection({
      workspacePath,
      fs,
      queryClient,
      queryKey: fileQueryKeys.metadata(workspacePath),
      refetchInterval: METADATA_REFETCH_INTERVAL_MS,
      staleTime: LISTING_FRESH_MS,
      hydratedDirs,
      parentDirectory,
    }),
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
      hooks.emit("git:stale", { workspacePath });
    }, INVALIDATE_DEBOUNCE_MS);
  };

  const changed = (paths: string[]) => {
    hooks.emit("files:changed", { workspacePath, paths });
    invalidateDerived();
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

  const write = async (
    filePath: string,
    content: string,
    // Hashing an 8,000-line document is ~7 ms of main thread.
    contentHash = calculateContentHash(content),
  ) => {

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

  const hydrateDirectoryStats = async (dirPaths: readonly string[]) => {
    // Already hydrated: the refetch keeps those fresh, and the tree asks
    // again for every visible directory on each expand or collapse.
    const waits: Promise<void>[] = [];
    const pending: string[] = [];
    for (const dir of new Set(dirPaths)) {
      if (hydratedDirs.has(dir)) continue;
      const inFlight = hydrationInFlight.get(dir);
      if (inFlight) waits.push(inFlight);
      else pending.push(dir);
    }
    if (pending.length > 0) {
      const batch = statChildren(pending).finally(() => {
        for (const dir of pending) hydrationInFlight.delete(dir);
      });
      for (const dir of pending) hydrationInFlight.set(dir, batch);
      waits.push(batch);
    }
    await Promise.all(waits);
  };

  /** One stat batch and one write for every child of `dirs`: a first
   *  visit with many folders open asks for them all at once. */
  const statChildren = async (dirs: string[]) => {
    // Before the first walk lands there are no rows to stat: leave the
    // directories unhydrated, so the next request does them.
    if (!collections.metadata.isReady()) return;
    const wanted = new Set(dirs);
    // The refetch's parent test, not a relative path per row: this scans
    // the whole collection.
    const children = collections.metadata.toArray.filter((row) => {
      const parent = parentDirectory(row.path);
      return parent !== row.path && wanted.has(parent);
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
      // Some stats failed: the next request retries rather than the
      // directories waiting out the refetch.
      if (result.failed.length > 0) return;
    }

    for (const dir of dirs) hydratedDirs.add(dir);
  };

  const dropQueries = () => {
    // Stop the collections first: left to their own gc (five minutes),
    // they hold every row and keep re-walking the listing on its interval.
    void collections.metadata.cleanup();
    void collections.content.cleanup();
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
      write: (content, contentHash) => write(filePath, content, contentHash),
      rename: (newPath) => rename(filePath, newPath),
      delete: () => remove(filePath),
      entry: () => entry(filePath),
      prefetch: () => prefetch(filePath),
    }),
    refresh: async () => {
      await collections.metadata.utils.refetch();
    },
    catchUp: async (maxAgeMs) => {
      const state = queryClient.getQueryState(
        fileQueryKeys.metadata(workspacePath),
      );
      if (state?.fetchStatus === "fetching") return;
      if (state && Date.now() - state.dataUpdatedAt < maxAgeMs) return;
      await collections.metadata.utils.refetch();
    },
    refetchMetadata,
    recordDiskChanges,
    hydrateDirectoryStats,
    updateLoadedContent,
    invalidateDerived,
    changed,
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
  needs: [platformModule, queryClientModule],
  // Coming back to a workspace re-walks its listing (catches watcher gaps)
  // unless a walk is running or recent, and gives a watcher whose start
  // failed another chance.
  boot: (_api, ctx) =>
    ctx.hooks.on("workspace:focused", ({ path }) => {
      // An earlier focus step can still be waiting when the workspace
      // closes; closing drops it from the open set before teardown, so
      // this also skips one whose instances are being disposed.
      const workspace = ctx.workspaceHandle(path);
      if (!workspace.isOpen()) return;
      const { files } = workspace;
      files.ensureWatching();
      void files.catchUp(LISTING_FRESH_MS);
    }),
  workspace: {
    create: (ctx) =>
      createWorkspaceFiles({
        workspacePath: pathutil.normalize(ctx.workspace.path),
        fs: ctx.use("platform").fs,
        queryClient: ctx.use("queryClient"),
        hooks: ctx.hooks,
      }),
    dispose: (files) => files.dispose(),
  },
});
