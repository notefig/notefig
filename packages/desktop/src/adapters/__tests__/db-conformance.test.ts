import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createCollection } from "@tanstack/react-db";
import {
  createTauriSQLitePersistence,
  persistedCollectionOptions,
} from "@tanstack/tauri-db-sqlite-persistence";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

/**
 * The persistence stack, everything except the IPC hop (MET-123). Drives the
 * real `createTauriSQLitePersistence` against an in-process SQLite; the rusqlite
 * commands are covered by `db_ops.rs`'s tests and `tests/shim/db-ops.spec.ts`.
 */

/**
 * A `TauriSQLiteDatabaseLike` over `node:sqlite`. The bound-parameter handling
 * is an assertion, not incidental: the driver rewrites `?` into `$1, $2, …`, and
 * `node:sqlite` only accepts those as *bare named* parameters — so this double
 * works at all only if the rewrite really happens.
 */
function nodeDatabase(): {
  path: string;
  execute: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowsAffected: number; lastInsertId: number }>;
  select: <T>(sql: string, params?: unknown[]) => Promise<T>;
  close: () => Promise<boolean>;
} {
  const database = new DatabaseSync(":memory:");

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
    execute: async (sql, params) => {
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

type Note = { id: string; title: string };

function noteCollection(
  persistence: PersistedCollectionPersistence,
  options: { id: string; schemaVersion?: number },
) {
  return createCollection(
    persistedCollectionOptions<Note, string>({
      // Always explicit — omitting it makes the core mint a random UUID and
      // derive the table name from it, so data lands in a fresh table each
      // session and silently never comes back.
      id: options.id,
      getKey: (note) => note.id,
      persistence,
      ...(options.schemaVersion === undefined
        ? {}
        : { schemaVersion: options.schemaVersion }),
    }),
  );
}

describe("SQLite persistence through the official Tauri driver", () => {
  it("round-trips inserts, updates and deletes", async () => {
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });
    const notes = noteCollection(persistence, { id: "notes" });
    await notes.preload();

    notes.insert({ id: "a", title: "first" });
    notes.insert({ id: "b", title: "second" });
    await notes.stateWhenReady();

    notes.update("a", (draft) => {
      draft.title = "edited";
    });
    notes.delete("b");
    await notes.stateWhenReady();

    // toMatchObject, not toEqual — rows carry `$key`/`$origin`/`$synced`.
    expect(notes.get("a")).toMatchObject({ id: "a", title: "edited" });
    expect(notes.get("b")).toBeUndefined();
  });

  it("restores rows into a second collection built on the same persistence", async () => {
    // The durability claim: the second instance never sees the inserts in
    // memory, so anything it reports came back out of SQLite.
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });

    const first = noteCollection(persistence, { id: "notes" });
    await first.preload();
    first.insert({ id: "a", title: "durable" });
    await first.stateWhenReady();
    await first.cleanup();

    const second = noteCollection(persistence, { id: "notes" });
    await second.preload();

    expect(second.get("a")).toMatchObject({
      id: "a",
      title: "durable",
      // An optimistic local row would read `$origin: "local"` — this is what
      // distinguishes a genuine restore from never having forgotten.
      $origin: "remote",
      $synced: true,
    });
  });

  it("keeps collections with different ids in separate tables", async () => {
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });

    const notes = noteCollection(persistence, { id: "notes" });
    const drafts = noteCollection(persistence, { id: "drafts" });
    await Promise.all([notes.preload(), drafts.preload()]);

    // The same key in both, different values. Asserting only that one cannot
    // see the other would also pass if `drafts` never persisted anything.
    notes.insert({ id: "shared-key", title: "in notes" });
    drafts.insert({ id: "shared-key", title: "in drafts" });
    await Promise.all([notes.stateWhenReady(), drafts.stateWhenReady()]);

    const rereadNotes = noteCollection(persistence, { id: "notes" });
    const rereadDrafts = noteCollection(persistence, { id: "drafts" });
    await Promise.all([rereadNotes.preload(), rereadDrafts.preload()]);

    expect(rereadNotes.get("shared-key")).toMatchObject({ title: "in notes" });
    expect(rereadDrafts.get("shared-key")).toMatchObject({
      title: "in drafts",
    });
  });

  it("drops persisted rows when schemaVersion moves, per the reset policy", async () => {
    // `reset` over the default `sync-absent-error`: there is no migration API
    // upstream, and a local-only collection that throws on open would take the
    // feature down rather than lose a cache.
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });

    const v1 = noteCollection(persistence, { id: "notes", schemaVersion: 1 });
    await v1.preload();
    v1.insert({ id: "a", title: "old shape" });
    await v1.stateWhenReady();
    await v1.cleanup();

    const v2 = noteCollection(persistence, { id: "notes", schemaVersion: 2 });
    await v2.preload();

    expect(v2.get("a")).toBeUndefined();
    expect(v2.size).toBe(0);
  });
});

describe("driver transaction semantics", () => {
  /**
   * The guarantees MET-117 assumed we would have to build ourselves. The driver
   * keeps itself private, so these are observed through collection writes.
   */
  it("rolls a failed write back rather than leaving a partial row behind", async () => {
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });
    const notes = noteCollection(persistence, { id: "notes" });
    await notes.preload();

    // The persistence layer wraps each mutation batch in a transaction, so a
    // broken rollback would leave the failed insert's row behind.
    notes.insert({ id: "kept", title: "kept" });
    await notes.stateWhenReady();

    await expect(
      (async () => {
        const transaction = notes.insert({ id: "kept", title: "duplicate" });
        await transaction.isPersisted.promise;
      })(),
    ).rejects.toThrow();

    expect(notes.get("kept")).toMatchObject({ id: "kept", title: "kept" });
  });

  it("serializes concurrent mutation batches instead of interleaving them", async () => {
    // Bypassing the driver's queue would overlap two BEGIN IMMEDIATE blocks, and
    // SQLite would either error or lose a write.
    const persistence = createTauriSQLitePersistence({
      database: nodeDatabase(),
      schemaMismatchPolicy: "reset",
    });
    const notes = noteCollection(persistence, { id: "notes" });
    await notes.preload();

    const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
    await Promise.all(
      ids.map(async (id) => {
        const transaction = notes.insert({ id, title: id });
        await transaction.isPersisted.promise;
      }),
    );

    const reread = noteCollection(persistence, { id: "notes" });
    await reread.preload();

    expect([...reread.keys()].sort()).toEqual([...ids].sort());
  });
});
