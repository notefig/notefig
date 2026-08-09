import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";

/**
 * The web `db` surface's failure paths (MET-123).
 *
 * OPFS and its worker do not exist under happy-dom, so the package is mocked
 * and this covers the two things that are ours rather than upstream's: that a
 * failed open is not cached forever, and that the corruption guard — which
 * deletes the user's data — reports honestly when the deletion did not happen.
 */

const openDatabase = vi.hoisted(() => vi.fn());
const createPersistence = vi.hoisted(() =>
  vi.fn((_options: { database: BrowserWASQLiteDatabase }) => ({ adapter: {} })),
);

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  openBrowserWASQLiteOPFSDatabase: openDatabase,
  createBrowserWASQLitePersistence: createPersistence,
  BrowserCollectionCoordinator: class {},
}));
vi.mock("@/telemetry/telemetry", () => ({ captureEvent: vi.fn() }));

import { createBrowserDb } from "../browser-db";

function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

/** The lazy database object the surface hands to the persistence package. */
function databaseUnderTest(): BrowserWASQLiteDatabase {
  createPersistence.mockClear();
  createBrowserDb().get();
  return createPersistence.mock.calls[0][0].database;
}

let removeEntry: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDatabase.mockReset();
  removeEntry = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "storage", {
    value: {
      persist: vi.fn().mockResolvedValue(true),
      getDirectory: vi.fn().mockResolvedValue({ removeEntry }),
    },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening the OPFS database", () => {
  it("retries after a failed open instead of caching the rejection", async () => {
    // Private browsing, a handle held by a closing tab, a worker that lost a
    // race — all transient. Caching the rejection would take storage down for
    // the rest of the session.
    openDatabase
      .mockRejectedValueOnce(new Error("OPFS unavailable"))
      .mockResolvedValueOnce({
        execute: vi.fn().mockResolvedValue([{ a: 1 }]),
      });

    const database = databaseUnderTest();

    await expect(database.execute("SELECT 1")).rejects.toThrow(
      "OPFS unavailable",
    );
    await expect(database.execute("SELECT 1")).resolves.toEqual([{ a: 1 }]);
    expect(openDatabase).toHaveBeenCalledTimes(2);
  });

  it("opens once and reuses the handle while it keeps working", async () => {
    openDatabase.mockResolvedValue({
      execute: vi.fn().mockResolvedValue([]),
    });

    const database = databaseUnderTest();
    await Promise.all([
      database.execute("SELECT 1"),
      database.execute("SELECT 2"),
    ]);
    await database.execute("SELECT 3");

    expect(openDatabase).toHaveBeenCalledTimes(1);
  });
});

describe("corruption guard", () => {
  function corruptOnce() {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("SQLITE_CORRUPT: database disk image is malformed"),
      )
      .mockResolvedValue([{ recovered: true }]);
    openDatabase.mockResolvedValue({ execute, close: vi.fn() });
    return execute;
  }

  it("deletes the database and its sidecars, then retries", async () => {
    const execute = corruptOnce();

    await expect(databaseUnderTest().execute("SELECT 1")).resolves.toEqual([
      { recovered: true },
    ]);

    // wa-sqlite keeps the journal beside the database; leaving one behind would
    // have the reopened database read the old journal back.
    expect(removeEntry.mock.calls.map(([name]) => name)).toEqual([
      "notefig.db",
      "notefig.db-wal",
      "notefig.db-shm",
      "notefig.db-journal",
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("treats an absent file as a successful deletion", async () => {
    corruptOnce();
    removeEntry.mockRejectedValue(domError("NotFoundError"));

    await expect(databaseUnderTest().execute("SELECT 1")).resolves.toEqual([
      { recovered: true },
    ]);
  });

  it("surfaces a deletion that failed rather than reporting a recovery", async () => {
    // OPFS refuses removeEntry while a sync access handle is still open. If
    // that is swallowed, the guard claims success and retries against the same
    // corrupt file — and the user is told nothing.
    const execute = corruptOnce();
    removeEntry.mockRejectedValue(domError("NoModificationAllowedError"));

    await expect(databaseUnderTest().execute("SELECT 1")).rejects.toThrow(
      "NoModificationAllowedError",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves the database alone for errors that are not corruption", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("disk I/O error"));
    openDatabase.mockResolvedValue({ execute, close: vi.fn() });

    await expect(databaseUnderTest().execute("SELECT 1")).rejects.toThrow(
      "disk I/O error",
    );

    expect(removeEntry).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
