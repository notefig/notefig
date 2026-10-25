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

/** Schema statements that are no-ops once they have run on a database. */
const IDEMPOTENT_SCHEMA =
  /^\s*(CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN)\b/i;

/** Statements after which a remembered schema statement may no longer hold. */
const UNDOES_SCHEMA = /^\s*(DROP|ROLLBACK)\b/i;

function isDuplicateColumn(error: unknown): boolean {
  return error instanceof Error && /duplicate column/i.test(error.message);
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

  /**
   * Idempotent schema statements this connection has settled, by text. The
   * persistence package initialises its shared tables once per adapter but
   * marks itself initialised only after the last statement, so every
   * collection loading at boot re-runs the whole set — about a hundred
   * round trips that queue in front of the first real queries. Each such
   * statement now runs once: a success is kept, and so is a duplicate-column
   * failure (the column already exists, which the package expects and
   * catches); any other failure is retried next time. Anything that can undo
   * schema — a DROP (an index or table the package recreates with the same
   * text), a ROLLBACK, a reset — forgets them all.
   */
  private readonly schemaStatements = new Map<string, Promise<QueryResult>>();

  execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    if (UNDOES_SCHEMA.test(query)) this.schemaStatements.clear();
    if (bindValues?.length || !IDEMPOTENT_SCHEMA.test(query)) {
      return this.run(query, bindValues);
    }
    const settled = this.schemaStatements.get(query);
    if (settled) return settled;
    const result = this.run(query, bindValues);
    this.schemaStatements.set(query, result);
    result.catch((error) => {
      if (!isDuplicateColumn(error)) this.schemaStatements.delete(query);
    });
    return result;
  }

  private run(query: string, bindValues?: unknown[]): Promise<QueryResult> {
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
        this.schemaStatements.clear();
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
