/**
 * The metadata collection: one row per entry of a workspace's listing,
 * synced from the recursive walk.
 *
 * TanStack Query still runs the walk (`fileQueryKeys.metadata`): retries,
 * the 30 s refetch, staleness, fetching and error state (the access-error
 * boundary reads it) are the query's. The rows are not a query collection
 * though: that mirrors every direct write back into the query cache, and
 * the cache update re-diffs every row — 20–45 ms per write at 20k files,
 * for a save's restat, a stat hydration, a watcher event, each child of a
 * renamed directory. Here a direct write touches only its rows, and a walk
 * diffs its listing against the synced rows once.
 */
import {
  BasicIndex,
  createCollection,
  type ChangeMessageOrDeleteKeyMessage,
  type PendingMutation,
} from "@tanstack/react-db";
import {
  QueryObserver,
  type QueryClient,
  type QueryObserverResult,
} from "@tanstack/react-query";
import {
  FsError,
  isWorkspaceAccessError,
  type FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { IGNORE_RULES } from "@/utils/ignore";
import { relativeTreePath } from "@/utils/path";
import type { FileMetadata } from "./files";

type Write = ChangeMessageOrDeleteKeyMessage<FileMetadata, string>;
type ObserverResult = QueryObserverResult<FileMetadata[], Error>;

interface SyncHandle {
  begin(options?: { immediate?: boolean }): void;
  write(message: Write): void;
  commit(): void;
}

export interface MetadataCollectionDeps {
  workspacePath: string;
  fs: FileSystemSurface;
  queryClient: QueryClient;
  queryKey: readonly unknown[];
  refetchInterval: number;
  staleTime: number;
  /** Directories whose children have been stat'd: the walk re-stats them. */
  hydratedDirs: ReadonlySet<string>;
  parentDirectory(path: string): string;
}

export function createMetadataCollection({
  workspacePath,
  fs,
  queryClient,
  queryKey,
  refetchInterval,
  staleTime,
  hydratedDirs,
  parentDirectory,
}: MetadataCollectionDeps) {
  /** The synced rows: what a walk diffs against. */
  const synced = new Map<string, FileMetadata>();
  /** The paths the last landed walk listed. A walk only drops rows an
   *  earlier walk listed: a row written directly for a path no walk sees
   *  (an ignored one) stays, as it always has. */
  let listed = new Set<string>();
  /** Rows written directly since the running walk started: its listing may
   *  predate them, so it neither drops nor overwrites them. */
  const writtenDuringWalk = new Set<string>();
  let handle: SyncHandle | null = null;
  /** Writes collected by `writeBatch`, applied as one transaction. */
  let batch: Write[] | null = null;

  const apply = (writes: Write[]) => {
    if (writes.length === 0) return;
    if (!handle) throw new Error("metadata collection is not syncing");
    // Immediate: a direct write lands even while a user transaction is
    // persisting (a mutation handler writes its own confirmed rows).
    handle.begin({ immediate: true });
    for (const message of writes) {
      handle.write(message);
      if (message.type === "delete") synced.delete(keyOf(message));
      else synced.set(message.value.path, message.value);
    }
    handle.commit();
  };

  const directWrite = (writes: Write[]) => {
    for (const message of writes) writtenDuringWalk.add(keyOf(message));
    if (batch) batch.push(...writes);
    else apply(writes);
  };

  const upsert = (row: FileMetadata): Write =>
    synced.has(row.path)
      ? { type: "update", value: row }
      : { type: "insert", value: row };

  const walk = async (): Promise<FileMetadata[]> => {
    writtenDuringWalk.clear();
    const listing = await fs.readDirectory(workspacePath, {
      recursive: true,
      ignore: IGNORE_RULES,
      includeFiles: true,
      includeDirectories: true,
    });
    if (!listing.ok) {
      // Typed, so WorkspaceErrorBoundary can recognize permission failures
      // and render the recovery fallback instead of DebugPanel.
      const { type, path, message } = listing.error;
      throw new FsError(type, path, message);
    }

    // Directories first, matching the old dirs-then-files ordering.
    const entries = [
      ...listing.value.filter((e) => e.type === "directory"),
      ...listing.value.filter((e) => e.type === "file"),
    ];

    // Re-stat children of hydrated directories so their stats stay fresh
    // across walks instead of pinning to hydration time.
    const statMap = new Map<string, { modifiedAt: Date; size: number }>();
    if (hydratedDirs.size > 0) {
      const pathsToStat = entries
        .filter((e) => hydratedDirs.has(parentDirectory(e.path)))
        .map((e) => e.path);
      if (pathsToStat.length > 0) {
        const statResult = await fs.getMetadata(pathsToStat);
        for (const m of statResult.succeeded) {
          statMap.set(m.path, { modifiedAt: m.modifiedAt, size: m.size });
        }
      }
    }

    // Merge, don't wipe: a row the walk still sees keeps its hydrated
    // stats and self-write bookkeeping — the very object, when nothing
    // about it changed, so the diff skips it.
    return entries.map(({ path, type }) => {
      const stat = statMap.get(path);
      const previous = synced.get(path);
      if (!previous) return freshRow(path, type, stat);
      if (previous.type === type && stat === undefined) return previous;
      return {
        ...previous,
        type,
        modified: stat ? stat.modifiedAt : previous.modified,
        size: stat ? stat.size : previous.size,
      };
    });
  };

  const freshRow = (
    path: string,
    type: FileMetadata["type"],
    stat: { modifiedAt: Date; size: number } | undefined,
  ): FileMetadata => ({
    path,
    relativePath: relativeTreePath(workspacePath, path),
    type,
    modified: stat?.modifiedAt,
    size: stat?.size,
    contentHash: "",
  });

  /** A landed walk: its listing is disk truth, except for rows written
   *  since it started. */
  const reconcile = (rows: FileMetadata[]) => {
    const seen = new Set<string>();
    const writes: Write[] = [];
    for (const row of rows) {
      seen.add(row.path);
      if (writtenDuringWalk.has(row.path)) continue;
      if (synced.get(row.path) === row) continue;
      writes.push(upsert(row));
    }
    for (const path of listed) {
      if (seen.has(path)) continue;
      // Written since this walk started, so its absence may be stale: keep
      // it listed and let the next walk decide.
      if (writtenDuringWalk.has(path)) seen.add(path);
      else if (synced.has(path)) writes.push({ type: "delete", key: path });
    }
    listed = seen;
    apply(writes);
  };

  const observer = new QueryObserver<FileMetadata[], Error>(queryClient, {
    queryKey,
    queryFn: walk,
    refetchInterval,
    staleTime,
    // Rows are reconciled by reference above; sharing would walk every
    // row of both listings for nothing.
    structuralSharing: false,
    // Access errors can't be retried away — fail fast so the recovery UI
    // (WorkspaceErrorBoundary) shows immediately.
    retry: (failureCount, error) =>
      !isWorkspaceAccessError(error) && failureCount < 3,
  });

  const refetch = async () => {
    await observer.refetch();
  };

  const confirm = async <T extends PendingMutation<FileMetadata>>(
    mutations: T[],
    toWrite: (mutation: T) => Write,
  ) => directWrite(mutations.map(toWrite));

  const collection = createCollection<FileMetadata, string>({
    getKey: (item) => item.path,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        handle = { begin, write, commit };
        let ready = false;
        let landed: unknown;
        // Only a new listing reconciles, and a failure is reported once;
        // status-only updates do nothing. Either way the collection is
        // ready: an error state shows through the query.
        const onUpdate = (result: ObserverResult) => {
          const outcome = result.isSuccess ? result.data : result.error;
          if (outcome === null || outcome === landed) return;
          landed = outcome;
          if (result.isSuccess) reconcile(result.data);
          else {
            console.error(
              `[files] listing walk of ${workspacePath} failed:`,
              result.error,
            );
          }
          if (!ready) {
            ready = true;
            markReady();
          }
        };
        const unsubscribe = observer.subscribe(onUpdate);
        // A listing already cached (a reseed) never notifies.
        onUpdate(observer.getCurrentResult());
        return () => {
          unsubscribe();
          handle = null;
        };
      },
    },

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
      // They are on disk as inserted: no walk needed to confirm them.
      await confirm(transaction.mutations, (m) => upsert(m.modified));
    },

    onUpdate: async ({ transaction }) => {
      let hasRename = false;
      for (const mutation of transaction.mutations) {
        const oldPath = String(mutation.key);
        const newPath = mutation.modified.path;
        if (oldPath === newPath) continue;
        hasRename = true;
        const moveResult =
          mutation.original.type === "file"
            ? await fs.moveFile(oldPath, newPath)
            : await fs.moveDirectory(oldPath, newPath);
        if (!moveResult.ok) {
          throw new Error(
            `Failed to move ${mutation.original.type} ${oldPath} to ${newPath}: ${moveResult.error.message}`,
          );
        }
      }
      // Renames change keys, so let a walk rebuild the tree. Plain
      // metadata updates (e.g. the modified timestamp after every save)
      // must not trigger one: a full workspace scan per save is wasteful.
      // Their confirmed values go straight into the synced rows instead,
      // so state survives the optimistic overlay being dropped on commit.
      if (hasRename) {
        await refetch();
        return;
      }
      await confirm(transaction.mutations, (m) => upsert(m.modified));
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
      await confirm(transaction.mutations, (m) => ({
        type: "delete",
        key: String(m.key),
      }));
    },

    utils: {
      /** Re-walk the listing; resolves once it has landed. */
      refetch,
      writeInsert: (row: FileMetadata) =>
        directWrite([{ type: "insert", value: row }]),
      writeUpdate: (row: FileMetadata) =>
        directWrite([{ type: "update", value: row }]),
      writeUpsert: (rows: FileMetadata | FileMetadata[]) =>
        directWrite((Array.isArray(rows) ? rows : [rows]).map(upsert)),
      writeDelete: (path: string) =>
        directWrite([{ type: "delete", key: path }]),
      /** The writes made in `callback`, as one transaction. */
      writeBatch: (callback: () => void) => {
        if (batch) throw new Error("writeBatch calls do not nest");
        batch = [];
        try {
          callback();
          apply(batch);
        } finally {
          batch = null;
        }
      },
    },
  });
  // The open-tab join looks its rows up by path: without an index, every
  // change to the open tabs scanned all 20k rows.
  collection.createIndex((row) => row.path, { indexType: BasicIndex });
  return collection;
}

function keyOf(message: Write): string {
  return message.type === "delete" && "key" in message
    ? message.key
    : (message as { value: FileMetadata }).value.path;
}
