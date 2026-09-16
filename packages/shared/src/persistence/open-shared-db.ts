/**
 * The app's database, opened from a process that is not the app.
 *
 * The desktop reaches `notefig.db` through rusqlite behind Tauri IPC; the CLI
 * opens the same file with a synchronous SQLite handle (better-sqlite3). Both
 * go through the same TanStack driver — the Tauri one, fed here by a small
 * shim over the handle — so there is one driver to reason about, one
 * statement queue discipline, and one `BEGIN IMMEDIATE` per transaction on
 * every host. The shim is the desktop test double's approach
 * (desktop/src/testing/node-db.ts) over a production binding.
 *
 * Nothing TanStack-typed crosses this module's boundary. The CLI compiles with
 * TypeScript 4.8, which cannot parse TanStack DB's declarations, so callers
 * get a narrow store interface and hand in the handle as a duck type.
 */
import { createCollection } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { createTauriSQLitePersistence } from "@tanstack/tauri-db-sqlite-persistence";
import type { AgentTaskRow } from "../agent/task-state";
import {
  agentTasksCollectionIdentity,
  kvCollectionIdentity,
  type KvRow,
} from "./collections";
import { raceSafeRegistrationSql } from "./race-safe-registration";
import { SharedDbCoordinator } from "./shared-db-coordinator";

/** The parts of a better-sqlite3 `Database` this uses. */
export interface SyncSqliteHandle {
  readonly name: string;
  prepare(sql: string): {
    readonly reader: boolean;
    run(...params: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    all(...params: unknown[]): unknown[];
  };
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

/** How long opening waits for another process to finish setting up the file:
 *  the same bound as the busy timeout both hosts use for statements. */
const WAL_SETUP_WAIT_MS = 5000;
const WAL_SETUP_RETRY_MS = 20;

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || /database is locked/i.test(String(error));
}

/**
 * Put the file in WAL mode, as the app does (db_ops.rs), tolerating other
 * processes opening it at the same moment.
 *
 * WAL is a property of the file and persists, so this is a no-op for any
 * database the app has already opened. Switching a brand-new file needs an
 * exclusive lock, and SQLite does not apply the busy timeout to that switch:
 * a second process opening the same fresh file fails with SQLITE_BUSY at once
 * (seen with three processes starting together). So check before switching,
 * and when the lock is contended, check again — usually the other process has
 * just done the switch — before waiting briefly and retrying, for no longer
 * than a statement would wait on a busy lock.
 */
function ensureWalMode(handle: SyncSqliteHandle): void {
  const waitUntil = Date.now() + WAL_SETUP_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const mode = String(handle.pragma("journal_mode", { simple: true }));
      if (mode.toLowerCase() === "wal") return;
      handle.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= waitUntil) throw error;
      // Synchronous: opening is synchronous for its callers.
      Atomics.wait(pause, 0, 0, WAL_SETUP_RETRY_MS);
    }
  }
}

/**
 * A Tauri `Database`-shaped object over a synchronous handle. The driver
 * rewrites `?` placeholders to `$1, $2, …`; SQLite reads those as named
 * parameters "1", "2", …, which is exactly how they are bound here.
 */
/**
 * Re-throw a driver error as an `Error` of this realm, keeping its `code`.
 *
 * The persistence core decides some failures are benign by reading
 * `error.message` behind an `instanceof Error` check — its schema migration
 * adds columns on every open and swallows "duplicate column name" that way.
 * An error from another realm fails that check and turns a no-op into a failed
 * startup. A native addon is loaded once per process, so its error class
 * belongs to whichever realm loaded it first (seen under Jest, which runs each
 * test file in its own context). The desktop normalizes its rejections for the
 * same check (toDbOpError in tauri-db.ts).
 */
function inThisRealm(error: unknown): unknown {
  if (error instanceof Error) return error;
  if (error !== null && typeof error === "object" && "message" in error) {
    const source = error as { message: unknown; code?: unknown; name?: unknown };
    const normalized = new Error(String(source.message)) as Error & {
      code?: unknown;
    };
    if (typeof source.name === "string") normalized.name = source.name;
    normalized.code = source.code;
    return normalized;
  }
  return error;
}

function tauriDatabaseOver(handle: SyncSqliteHandle) {
  const bind = (params?: unknown[]): unknown[] => {
    if (!params || params.length === 0) return [];
    const named: Record<string, unknown> = {};
    params.forEach((value, index) => {
      named[String(index + 1)] = value;
    });
    return [named];
  };

  return {
    path: handle.name,
    execute: async (sql: string, params?: unknown[]) => {
      try {
        const statement = handle.prepare(raceSafeRegistrationSql(sql));
        if (statement.reader) {
          // A statement that returns rows (a PRAGMA, say) cannot `run`.
          statement.all(...bind(params));
          return { rowsAffected: 0, lastInsertId: 0 };
        }
        const result = statement.run(...bind(params));
        return {
          rowsAffected: Number(result.changes),
          lastInsertId: Number(result.lastInsertRowid),
        };
      } catch (error) {
        throw inThisRealm(error);
      }
    },
    select: async <T>(sql: string, params?: unknown[]): Promise<T> => {
      try {
        return handle.prepare(sql).all(...bind(params)) as T;
      } catch (error) {
        throw inThisRealm(error);
      }
    },
    close: async () => {
      handle.close();
      return true;
    },
  };
}

/** The task rows, through the same collection the app uses. */
export interface SharedAgentTaskStore {
  get(taskId: string): AgentTaskRow | undefined;
  /** Every task row, once the collection has loaded. */
  all(): Promise<AgentTaskRow[]>;
  insert(row: AgentTaskRow): Promise<void>;
  update(taskId: string, patch: Partial<AgentTaskRow>): Promise<void>;
  /**
   * Make the stored row exactly `row`: fields `row` does not carry are
   * removed, not left behind. How a run hands its task back in the shape the
   * app's boot mapping produces.
   */
  replace(row: AgentTaskRow): Promise<void>;
  delete(taskId: string): Promise<void>;
}

export interface SharedDb {
  tasks: SharedAgentTaskStore;
  /** One KV value, as the app's `readKv` would return it. */
  readKv<T>(namespace: string, key: string): Promise<T | undefined>;
  /** Insert-or-update one KV value, as the app's `writeKv` would. */
  writeKv(namespace: string, key: string, value: unknown): Promise<void>;
  /** Stop coordinating and close the handle. Pending writes are awaited by
   *  the store methods themselves, so call this after the last one resolves. */
  close(): Promise<void>;
}

export type OpenSharedDbOptions = {
  /** Poll interval for other processes' commits; see SharedDbCoordinator. */
  pollIntervalMs?: number;
  warn?: (message: string, error: unknown) => void;
};

export function openSharedDb(
  handle: SyncSqliteHandle,
  options: OpenSharedDbOptions = {},
): SharedDb {
  ensureWalMode(handle);
  const coordinator = new SharedDbCoordinator(options);
  const persistence = coordinator.coordinate(
    createTauriSQLitePersistence({
      database: tauriDatabaseOver(handle) as never,
      coordinator,
      // Must match the app (desktop tauri-db.ts): both open the same tables.
      schemaMismatchPolicy: "reset",
    }),
  );

  const tasks = createCollection(
    persistedCollectionOptions<AgentTaskRow, string>({
      ...agentTasksCollectionIdentity,
      persistence,
    }),
  );
  const kvCollections = new Map<
    string,
    ReturnType<typeof createKvCollection>
  >();
  function createKvCollection(namespace: string) {
    return createCollection(
      persistedCollectionOptions<KvRow, string>({
        ...kvCollectionIdentity(namespace),
        persistence,
      }),
    );
  }

  const kvFor = (namespace: string) => {
    let collection = kvCollections.get(namespace);
    if (!collection) {
      collection = createKvCollection(namespace);
      kvCollections.set(namespace, collection);
    }
    return collection;
  };

  const ready = () => tasks.preload();

  return {
    tasks: {
      get: (taskId) => tasks.get(taskId),
      async all() {
        await ready();
        return [...tasks.values()];
      },
      async insert(row) {
        await ready();
        await tasks.insert(row).isPersisted.promise;
      },
      async update(taskId, patch) {
        await ready();
        await tasks.update(taskId, (draft) => {
          Object.assign(draft, patch);
        }).isPersisted.promise;
      },
      async replace(row) {
        await ready();
        if (!tasks.get(row.taskId)) {
          await tasks.insert(row).isPersisted.promise;
          return;
        }
        await tasks.update(row.taskId, (draft) => {
          Object.assign(draft, row);
          for (const key of Object.keys(draft)) {
            if (key.startsWith("$") || key in row) continue;
            (draft as Record<string, unknown>)[key] = undefined;
          }
        }).isPersisted.promise;
      },
      async delete(taskId) {
        await ready();
        if (!tasks.get(taskId)) return;
        await tasks.delete(taskId).isPersisted.promise;
      },
    },

    async readKv<T>(namespace: string, key: string) {
      const collection = kvFor(namespace);
      await collection.preload();
      return collection.get(key)?.value as T | undefined;
    },

    async writeKv(namespace, key, value) {
      const collection = kvFor(namespace);
      await collection.preload();
      const transaction = collection.get(key)
        ? collection.update(key, (draft) => {
            draft.value = value;
          })
        : collection.insert({ key, value });
      await transaction.isPersisted.promise;
    },

    async close() {
      coordinator.dispose();
      await tasks.cleanup();
      for (const collection of kvCollections.values()) {
        await collection.cleanup();
      }
      handle.close();
    },
  };
}
