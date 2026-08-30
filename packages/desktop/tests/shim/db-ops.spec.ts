import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * MET-123 — the SQLite commands through the real Rust backend, the half that
 * needs a real process. `db-conformance.test.ts` covers the driver and
 * collection layer; what it cannot reach is rusqlite itself: WAL on a real file,
 * JSON parameter binding across IPC, connection reuse between invokes, and the
 * error classification the corruption guard depends on.
 *
 * Requests go to `POST /invoke/{cmd}` as the frontend transport does. The shim
 * points `NOTEFIG_DB_DIR` at a temp dir it wipes at startup.
 */
const SHIM_PORT = Number(process.env.SHIM_PORT ?? 4599);
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`;
const DB_PATH = path.join(
  os.tmpdir(),
  `notefig-shim-db-${SHIM_PORT}`,
  "notefig.db",
);

type InvokeResult = { status: number; body: unknown };

async function invoke(cmd: string, args: unknown = {}): Promise<InvokeResult> {
  const res = await fetch(`${SHIM_URL}/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Asserts the command succeeded and returns its value. */
async function ok(cmd: string, args: unknown = {}): Promise<unknown> {
  const { status, body } = await invoke(cmd, args);
  expect(status, `${cmd} failed: ${JSON.stringify(body)}`).toBe(200);
  return body;
}

/** Asserts the command failed and returns the structured DbError. */
async function err(
  cmd: string,
  args: unknown = {},
): Promise<{ type: string; message: string }> {
  const { status, body } = await invoke(cmd, args);
  expect(status, `${cmd} unexpectedly succeeded`).not.toBe(200);
  return body as { type: string; message: string };
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

// The connection and file are process-global in the shim — which is what the
// connection-reuse assertions need.
test.describe.configure({ mode: "serial" });

test.describe("shim: db_ops against real rusqlite", () => {
  test.beforeEach(async () => {
    // Start from no database. `db_reset` is the app's own recovery path.
    await ok("db_reset");
  });

  test("no database file exists until a statement asks for one", async () => {
    // The lazy-open invariant: opening creates the file, and registering a
    // command opens nothing.
    expect(await exists(DB_PATH)).toBe(false);

    await ok("db_execute", { sql: "CREATE TABLE t (a TEXT)" });

    expect(await exists(DB_PATH)).toBe(true);
    // WAL was requested at open; its sidecar is the observable proof.
    expect(await exists(`${DB_PATH}-wal`)).toBe(true);
  });

  test("binds $N parameters positionally and reads the values back", async () => {
    await ok("db_execute", { sql: "CREATE TABLE t (a TEXT, b TEXT, c TEXT)" });
    await ok("db_execute", {
      sql: "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
      params: ["first", "second", "third"],
    });

    const rows = await ok("db_query", { sql: "SELECT a, b, c FROM t" });

    expect(rows).toEqual([{ a: "first", b: "second", c: "third" }]);
  });

  test("round-trips every JSON parameter type SQLite can hold", async () => {
    await ok("db_execute", { sql: "CREATE TABLE t (v)" });
    for (const value of [null, true, 7, 7.5, "text"]) {
      await ok("db_execute", {
        sql: "INSERT INTO t (v) VALUES ($1)",
        params: [value],
      });
    }

    const rows = (await ok("db_query", {
      sql: "SELECT v FROM t ORDER BY rowid",
    })) as { v: unknown }[];

    // `true` becomes 1 — SQLite has no boolean type. The integer/float
    // distinction does matter: 7 as 7.0 would change stored row versions.
    expect(rows.map((row) => row.v)).toEqual([null, 1, 7, 7.5, "text"]);
  });

  test("reports rows affected and the last inserted id", async () => {
    // The driver ignores these, but its type contract requires them, and
    // fabricated zeroes would be a lie the next reader inherits.
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });

    const result = await ok("db_execute", {
      sql: "INSERT INTO t (v) VALUES ($1)",
      params: ["x"],
    });

    expect(result).toMatchObject({ rowsAffected: 1 });
    expect((result as { lastInsertId: number }).lastInsertId).toBeGreaterThan(
      0,
    );
  });

  test("keeps one connection across invokes, so a transaction spans them", async () => {
    // The driver opens a transaction in one call and commits or rolls it back
    // in another, so a fresh connection per command would lose every rollback.
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });

    await ok("db_execute", { sql: "BEGIN IMMEDIATE" });
    await ok("db_execute", {
      sql: "INSERT INTO t (v) VALUES ($1)",
      params: ["discarded"],
    });
    await ok("db_execute", { sql: "ROLLBACK" });

    expect(await ok("db_query", { sql: "SELECT v FROM t" })).toEqual([]);
  });

  test("commits a transaction that spans invokes", async () => {
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });

    await ok("db_execute", { sql: "BEGIN IMMEDIATE" });
    await ok("db_execute", {
      sql: "INSERT INTO t (v) VALUES ($1)",
      params: ["kept"],
    });
    await ok("db_execute", { sql: "COMMIT" });

    expect(await ok("db_query", { sql: "SELECT v FROM t" })).toEqual([
      { v: "kept" },
    ]);
  });

  test("classifies a corrupted file as not_a_database, and db_reset recovers it", async () => {
    // The only place the guard's trigger meets a real SQLite rather than a
    // simulated error — and it deletes user data when it fires.
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });
    await ok("db_close");

    await fs.writeFile(DB_PATH, "not a database, not even close");
    for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      await fs.rm(sidecar, { force: true });
    }

    const failure = await err("db_execute", { sql: "SELECT 1" });
    expect(failure.type).toBe("not_a_database");

    await ok("db_reset");

    // Recovered: an empty database that accepts writes again.
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });
    expect(await ok("db_query", { sql: "SELECT v FROM t" })).toEqual([]);
  });

  test("reports a bad statement as sql, never as corruption", async () => {
    // The guard keys on `type`, so a misclassified syntax error would delete
    // the database over a typo.
    await ok("db_execute", { sql: "CREATE TABLE t (v TEXT)" });

    const failure = await err("db_execute", { sql: "SELECT FROM WHERE" });

    expect(failure.type).toBe("sql");
    expect(await exists(DB_PATH)).toBe(true);
  });

  test("refuses a structured parameter instead of stringifying it", async () => {
    await ok("db_execute", { sql: "CREATE TABLE t (v)" });

    const failure = await err("db_execute", {
      sql: "INSERT INTO t (v) VALUES ($1)",
      params: [{ nested: true }],
    });

    expect(failure.type).toBe("unsupported");
  });
});

/**
 * The persistence stack over the real transport, driven from the page.
 *
 * The suite above talks to the commands directly, which cannot see anything
 * about how the *frontend* shim behaves — including that Tauri rejects with a
 * plain payload rather than an `Error`, which broke upstream's schema migration
 * on the desktop path while every direct-invoke test stayed green.
 */
test.describe("shim: persisted collections over the real transport", () => {
  test.beforeEach(async () => {
    // Fresh database: the probe insert below assumes its row doesn't exist
    // yet, and a lastPath left by another spec would make `goto("/")` boot a
    // whole workspace whose collections transact concurrently with the probe.
    await ok("db_reset");
  });

  const driveCollection = (insert: boolean) => `
    (async () => {
      const [adapters, reactDb, persist] = await Promise.all([
        import('/src/adapters/index.ts'),
        // /@id/ lets the dev server resolve the bare specifiers (a
        // page-evaluated import can't) without hardcoding the dep-cache
        // location, which moved to .vite-shim for shim-mode servers.
        import('/@id/@tanstack/react-db'),
        import('/@id/@tanstack/tauri-db-sqlite-persistence'),
      ]);
      const c = reactDb.createCollection(persist.persistedCollectionOptions({
        id: 'shim-probe-notes',
        getKey: (n) => n.id,
        persistence: adapters.platformAdapter.db.get(),
      }));
      await c.preload();
      if (${insert}) {
        // isPersisted, not stateWhenReady — the latter resolves on collection
        // state, which is reached before the row reaches SQLite.
        await c.insert({ id: 'a', title: 'durable' }).isPersisted.promise;
      }
      const row = c.get('a');
      return { size: c.size, origin: row && row.$origin, title: row && row.title };
    })()
  `;

  test("starts up cleanly and survives a reload", async ({ page }) => {
    const failures: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      // Upstream logs its schema-migration failure as a warning and carries on
      // with a half-initialized database, so a passing write is not enough.
      // "Failed to fetch" is excluded: goto/reload aborts in-flight boot
      // fetches (harness discovery, collection loopback startup), and those
      // benign aborts carry "...persistence.js" frames in their stack, which
      // this filter would otherwise match. A genuinely dead transport still
      // fails the data assertions below.
      if (
        /persisted .*startup|persistence/i.test(text) &&
        /fail/i.test(text) &&
        !text.includes("Failed to fetch")
      ) {
        failures.push(text);
      }
    });

    await page.goto("/");
    const written = await page.evaluate(driveCollection(true));
    expect(written).toMatchObject({ size: 1, title: "durable" });

    await page.reload();
    const restored = await page.evaluate(driveCollection(false));

    // `remote` means it came back out of SQLite rather than never having left.
    expect(restored).toMatchObject({ size: 1, origin: "remote" });
    expect(failures).toEqual([]);
  });
});
