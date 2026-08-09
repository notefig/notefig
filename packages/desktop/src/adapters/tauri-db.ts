/**
 * Desktop half of the adapter's `db` surface (MET-123).
 *
 * `@tanstack/tauri-db-sqlite-persistence` ships the SQLite driver — statement
 * queue, transactions, savepoints, `?` → `$N` rewriting — and duck-types its
 * database argument, so the whole desktop implementation is the four-method
 * shim below over our own rusqlite commands (`src-tauri/src/db_ops.rs`).
 * `@tauri-apps/plugin-sql` is never installed as a Rust plugin and never
 * imported; npm pulls its types in as a peer, and that is all it is.
 */
import { invoke } from "@tauri-apps/api/core";
import { createTauriSQLitePersistence } from "@tanstack/tauri-db-sqlite-persistence";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import type { DbSurface } from "./platform-adapter.interface";
import { captureEvent } from "@/telemetry/telemetry";

/** Mirrors `DbErrorType` in `db_ops.rs`. */
type DbErrorType =
  | "corrupt"
  | "not_a_database"
  | "busy"
  | "io"
  | "sql"
  | "unsupported"
  | "unknown";

type DbError = { type: DbErrorType; message: string };

/**
 * Tauri rejects a `Result::Err` with the plain serialized payload, not an
 * `Error`. Upstream treats failures as real errors — the persistence core's
 * schema migration, for one, swallows "duplicate column name" by reading
 * `error.message` behind an `instanceof Error` check, and silently rethrows
 * everything else. So every rejection is normalized into this before it leaves
 * the shim, keeping `type` for our own classification.
 */
class DbOpError extends Error {
  constructor(
    readonly type: DbErrorType,
    message: string,
  ) {
    super(message);
    this.name = "DbOpError";
  }
}

function toDbOpError(error: unknown): unknown {
  if (error instanceof Error || typeof error !== "object" || error === null) {
    return error;
  }
  const { type, message } = error as Partial<DbError>;
  if (typeof type !== "string" || typeof message !== "string") return error;
  return new DbOpError(type as DbErrorType, message);
}

/**
 * The only two classes that justify deleting the user's database. Everything
 * else — a busy lock, a full disk, a bad statement — is transient or a bug, and
 * wiping the file would destroy recoverable data. Keep this set this size.
 */
const RECREATE_ON: ReadonlySet<DbErrorType> = new Set<DbErrorType>([
  "corrupt",
  "not_a_database",
]);

function isCorruption(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { type } = error as Partial<DbError>;
  return typeof type === "string" && RECREATE_ON.has(type as DbErrorType);
}

/** Matches `QueryResult` in `db_ops.rs` (and plugin-sql's own shape). */
type QueryResult = { rowsAffected: number; lastInsertId: number };

/**
 * A `TauriSQLiteDatabaseLike` over our rusqlite commands. The constructor
 * performs no `invoke`, so the file is created by the first statement rather
 * than at adapter construction.
 */
class RusqliteDatabase {
  /** Informational — Rust owns the real location. The driver requires a string. */
  readonly path = "notefig.db";

  private resetInFlight: Promise<void> | null = null;

  execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    return this.guarded(() =>
      invoke<QueryResult>("db_execute", { sql: query, params: bindValues }),
    );
  }

  select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    return this.guarded(() =>
      invoke<T>("db_query", { sql: query, params: bindValues }),
    );
  }

  async close(_db?: string): Promise<boolean> {
    // The argument is plugin-sql's database path; we hold one connection.
    return invoke<boolean>("db_close");
  }

  /**
   * DESTRUCTIVE RECOVERY. A corrupt file will never accept another statement,
   * so it is deleted and the statement retried once. A second failure
   * propagates — if a fresh database is also corrupt, the file is not the
   * problem.
   */
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (raw) {
      const error = toDbOpError(raw);
      if (!isCorruption(error)) throw error;
      await this.reset();
      try {
        return await run();
      } catch (retryError) {
        throw toDbOpError(retryError);
      }
    }
  }

  private reset(): Promise<void> {
    // Single-flight: several statements can be in flight when the file goes
    // bad, and each must not delete it out from under the others' retries.
    this.resetInFlight ??= (async () => {
      console.error(
        "The local database was unreadable and has been recreated. Anything it held is gone.",
      );
      captureEvent("db_corruption_reset", { platform: "tauri" });
      try {
        await invoke("db_reset");
      } finally {
        this.resetInFlight = null;
      }
    })();
    return this.resetInFlight;
  }
}

/**
 * The persistence is memoized because the package caches one driver — and so
 * one statement queue — per database object. A fresh database per call would
 * give each collection its own queue, letting two transactions interleave.
 */
export function createTauriDb(): DbSurface {
  let persistence: PersistedCollectionPersistence | null = null;

  return {
    get(): PersistedCollectionPersistence {
      persistence ??= createTauriSQLitePersistence({
        database: new RusqliteDatabase(),
        // Pre-GA, and upstream ships no migration API: a `schemaVersion` bump
        // drops the stored rows rather than failing to open. Whichever ticket
        // first bumps a version owes a release note.
        schemaMismatchPolicy: "reset",
      });
      return persistence;
    },
  };
}

/** Exported for the contract tests; not part of the surface. */
export { RusqliteDatabase };
