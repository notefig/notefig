/**
 * An in-process `db` surface for tests (MET-124).
 *
 * Everything durable now goes through `platformAdapter.db`, so a test that
 * touches settings, recent projects or agent tasks needs a real persistence —
 * an in-memory stub would not exercise the hydrate-from-storage path that is
 * the entire point of the cutover. This drives the real
 * `createTauriSQLitePersistence` against `node:sqlite`, so the only thing not
 * covered is the IPC hop (which `db_ops.rs`'s tests and `tests/shim/` cover).
 *
 * Test-only: it imports `node:sqlite` and must never be reachable from app code.
 */
import { DatabaseSync } from "node:sqlite";
import { createTauriSQLitePersistence } from "@tanstack/tauri-db-sqlite-persistence";
import {
  decodePersistedStorageKey,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import type { DbSurface } from "@/adapters/platform-adapter.interface";

/**
 * A `TauriSQLiteDatabaseLike` over `node:sqlite`. The bound-parameter handling
 * is an assertion, not incidental: the driver rewrites `?` into `$1, $2, …`, and
 * `node:sqlite` only accepts those as *bare named* parameters — so this double
 * works at all only if the rewrite really happens.
 */
function nodeDatabase(
  database: DatabaseSync,
  writeFailure: { reason: string | null },
) {
  const prepare = (sql: string, params?: unknown[]) => {
    const statement = database.prepare(sql);
    if (!params?.length) return { statement, bindings: undefined };
    statement.setAllowBareNamedParameters(true);
    const bindings: Record<string, unknown> = {};
    params.forEach((value, index) => {
      bindings[String(index + 1)] = value;
    });
    return { statement, bindings };
  };

  return {
    path: "memory.db",
    execute: async (sql: string, params?: unknown[]) => {
      // Reads still work while writes are broken, so a test can inspect what
      // survived the failure.
      if (writeFailure.reason && !/^\s*SELECT/i.test(sql)) {
        throw new Error(writeFailure.reason);
      }
      const { statement, bindings } = prepare(sql, params);
      const result = bindings ? statement.run(bindings) : statement.run();
      return {
        rowsAffected: Number(result.changes),
        lastInsertId: Number(result.lastInsertRowid),
      };
    },
    select: async <T>(sql: string, params?: unknown[]) => {
      const { statement, bindings } = prepare(sql, params);
      const rows = bindings ? statement.all(bindings) : statement.all();
      // Rows come back null-prototyped; spread them so assertions compare cleanly.
      return rows.map((row: Record<string, unknown>) => ({ ...row })) as T;
    },
    close: async () => {
      database.close();
      return true;
    },
  };
}

export interface NodeTestDb extends DbSurface {
  /**
   * Make every subsequent write fail, until `repairWrites()`. Exists because
   * persistence failure is now observable behavior — a failed commit rolls the
   * optimistic mutation back — and that is worth pinning rather than assuming.
   */
  breakWrites(reason: string): void;
  repairWrites(): void;
  /**
   * The rows exactly as SQLite holds them, for asserting what was *written*
   * rather than what the collection reports. The table name comes from
   * `collection_registry` rather than being recomputed, because the core
   * hashes long collection ids into a different name.
   */
  storedRows(
    collectionId: string,
  ): Array<{ key: string | number; value: Record<string, unknown> }>;
}

/**
 * A fresh, isolated database. Call it per test — collections are module-scoped
 * singletons, so sharing one across tests leaks rows between them.
 */
export function createNodeTestDb(): NodeTestDb {
  const database = new DatabaseSync(":memory:");
  const writeFailure: { reason: string | null } = { reason: null };
  let persistence: PersistedCollectionPersistence | null = null;

  return {
    breakWrites(reason) {
      writeFailure.reason = reason;
    },

    repairWrites() {
      writeFailure.reason = null;
    },

    get() {
      // Memoized like both real surfaces: one persistence means one driver, so
      // one statement queue over the file.
      persistence ??= createTauriSQLitePersistence({
        database: nodeDatabase(database, writeFailure),
        schemaMismatchPolicy: "reset",
      });
      return persistence;
    },

    storedRows(collectionId) {
      const registry = database
        .prepare(
          "SELECT table_name FROM collection_registry WHERE collection_id = ?",
        )
        .all(collectionId) as Array<{ table_name: string }>;
      const tableName = registry[0]?.table_name;
      if (!tableName) return [];
      const rows = database
        .prepare(`SELECT key, value FROM "${tableName}"`)
        .all() as Array<{ key: string; value: string }>;
      // Keys are stored encoded (`s:a`, `n:1`) so string and number keys can
      // share one TEXT column.
      return rows.map((row) => ({
        key: decodePersistedStorageKey(row.key),
        value: JSON.parse(row.value) as Record<string, unknown>,
      }));
    },
  };
}
