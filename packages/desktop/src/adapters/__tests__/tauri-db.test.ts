import { describe, expect, it, vi } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { createTauriSQLitePersistence } from "@tanstack/tauri-db-sqlite-persistence";
import { createTauriDb, RusqliteDatabase } from "../tauri-db";

const captureEvent = vi.hoisted(() => vi.fn());
vi.mock("@/telemetry/telemetry", () => ({ captureEvent }));

/**
 * The desktop shim between the persistence driver and our rusqlite commands
 * (MET-123). Two things are pinned here and nowhere else: the driver's
 * duck-typed database contract, whose tightening would otherwise surface at
 * runtime in production; and the corruption guard, which deletes the user's
 * database and so has both its firing and not-firing cases asserted.
 */

function dbError(type: string) {
  return { type, message: `simulated ${type}` };
}

describe("RusqliteDatabase as a driver database", () => {
  it("is accepted by createTauriSQLitePersistence", () => {
    withMockedTauri({});
    // The driver throws from its constructor when the shape does not satisfy
    // it, so getting an object back at all is the assertion.
    expect(() =>
      createTauriSQLitePersistence({ database: new RusqliteDatabase() }),
    ).not.toThrow();
  });

  it("sends SQL and bound parameters through to db_execute", async () => {
    const execute = vi.fn(() => ({ rowsAffected: 1, lastInsertId: 3 }));
    withMockedTauri({ db_execute: execute });

    const result = await new RusqliteDatabase().execute(
      "INSERT INTO t (a, b) VALUES ($1, $2)",
      ["x", 7],
    );

    expect(execute).toHaveBeenCalledWith({
      sql: "INSERT INTO t (a, b) VALUES ($1, $2)",
      params: ["x", 7],
    });
    expect(result).toEqual({ rowsAffected: 1, lastInsertId: 3 });
  });

  it("returns db_query rows as-is so the driver can validate their shape", async () => {
    withMockedTauri({ db_query: () => [{ a: 1 }] });

    await expect(
      new RusqliteDatabase().select("SELECT a FROM t"),
    ).resolves.toEqual([{ a: 1 }]);
  });

  it("rejects with a real Error, not the raw invoke payload", async () => {
    // Tauri rejects a Result::Err with the plain serialized object. Upstream's
    // schema migration swallows "duplicate column name" behind an
    // `instanceof Error` check and rethrows anything else — so a plain object
    // here turns every benign ALTER TABLE into a failed startup.
    withMockedTauri({
      db_execute: () => {
        throw { type: "sql", message: "duplicate column name: replay_json" };
      },
    });

    const error = await new RusqliteDatabase()
      .execute("ALTER TABLE applied_tx ADD COLUMN replay_json TEXT")
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("duplicate column name: replay_json");
    // `type` survives so our own corruption classification still works.
    expect(error.type).toBe("sql");
  });

  it("tolerates the database path the driver passes to close()", async () => {
    const close = vi.fn(() => true);
    withMockedTauri({ db_close: close });
    const database = new RusqliteDatabase();

    // The driver calls `database.close(database.path)` — a plugin-sql quirk.
    await expect(database.close(database.path)).resolves.toBe(true);
    expect(close).toHaveBeenCalled();
  });
});

describe("corruption guard", () => {
  it("recreates the database and retries once when the file is corrupt", async () => {
    let attempt = 0;
    const execute = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw dbError("corrupt");
      return { rowsAffected: 0, lastInsertId: 0 };
    });
    const reset = vi.fn(() => null);
    withMockedTauri({ db_execute: execute, db_reset: reset });

    await expect(
      new RusqliteDatabase().execute("SELECT 1"),
    ).resolves.toBeTruthy();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(captureEvent).toHaveBeenCalledWith("db_corruption_reset", {
      platform: "tauri",
    });
  });

  it("also recovers from a file that is not a database at all", async () => {
    let attempt = 0;
    const query = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw dbError("not_a_database");
      return [];
    });
    const reset = vi.fn(() => null);
    withMockedTauri({ db_query: query, db_reset: reset });

    await expect(new RusqliteDatabase().select("SELECT 1")).resolves.toEqual(
      [],
    );
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it.each(["busy", "io", "sql", "unsupported", "unknown"])(
    "does not delete anything for a %s error",
    async (type) => {
      const execute = vi.fn(() => {
        throw dbError(type);
      });
      const reset = vi.fn(() => null);
      withMockedTauri({ db_execute: execute, db_reset: reset });

      await expect(
        new RusqliteDatabase().execute("SELECT 1"),
      ).rejects.toMatchObject({ type, message: `simulated ${type}` });

      // The point of classifying in Rust: a locked database or a full disk
      // recovers on its own, and wiping it would make that permanent.
      expect(reset).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("gives up rather than looping when a freshly recreated database is also corrupt", async () => {
    const execute = vi.fn(() => {
      throw dbError("corrupt");
    });
    const reset = vi.fn(() => null);
    withMockedTauri({ db_execute: execute, db_reset: reset });

    await expect(
      new RusqliteDatabase().execute("SELECT 1"),
    ).rejects.toMatchObject({ type: "corrupt" });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("resets once for concurrent statements that all hit the corrupt file", async () => {
    // Without single-flighting, each in-flight statement would delete the
    // database again, out from under the others' retries.
    const seen = new Set<unknown>();
    const execute = vi.fn((payload: Record<string, unknown>) => {
      if (!seen.has(payload.sql)) {
        seen.add(payload.sql);
        throw dbError("corrupt");
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    });
    const reset = vi.fn(() => null);
    withMockedTauri({ db_execute: execute, db_reset: reset });

    const database = new RusqliteDatabase();
    await Promise.all([
      database.execute("SELECT 1"),
      database.execute("SELECT 2"),
      database.execute("SELECT 3"),
    ]);

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("the db surface itself", () => {
  it("touches no storage when the persistence is created", () => {
    const invoked: string[] = [];
    withMockedTauri(
      new Proxy(
        {},
        {
          get: (_target, command: string) => () => {
            invoked.push(command);
            return null;
          },
          has: () => true,
        },
      ),
    );

    createTauriDb().get();

    // MET-124 calls `get()` at module scope, so any invoke here is database
    // work at app boot.
    expect(invoked).toEqual([]);
  });

  it("hands every caller the same persistence", () => {
    withMockedTauri({});
    const db = createTauriDb();

    // One persistence means one driver, so one statement queue.
    expect(db.get()).toBe(db.get());
  });
});
