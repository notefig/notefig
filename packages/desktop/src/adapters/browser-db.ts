/**
 * Web half of the adapter's `db` surface (MET-123).
 *
 * `@tanstack/browser-db-sqlite-persistence` runs wa-sqlite over OPFS in a
 * dedicated worker (`OPFSCoopSyncVFS`, so no COOP/COEP headers). Opening is
 * async but `get()` cannot be, so the lazy boundary sits on the database object
 * — a two-method contract — rather than as a proxy over the persistence
 * adapter, whose optional methods upstream feature-detects.
 *
 * The worker's ~1.7 MB wasm is a separate emitted asset, so this static import
 * costs only the package's own small JS.
 */
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  type BrowserWASQLiteDatabase,
} from "@tanstack/browser-db-sqlite-persistence";
import type {
  ApplyLocalMutationsResponse,
  PersistedCollectionPersistence,
  PersistedIndexSpec,
  PersistedMutationEnvelope,
  PullSinceResponse,
} from "@tanstack/db-sqlite-persistence-core";
import type { DbSurface } from "./platform-adapter.interface";

// Declared by `@tanstack/db`, which is not a direct dependency — derived
// from the base class instead of importing the transitive package.
type LoadSubsetOptions = Parameters<
  BrowserCollectionCoordinator["requestEnsureRemoteSubset"]
>[1];
import { captureEvent } from "@/telemetry/telemetry";

const DATABASE_NAME = "notefig.db";

/**
 * Unlike the desktop path, which classifies on real SQLite error codes,
 * wa-sqlite's errors are not ours to shape — so this matches on text, which
 * makes it the weaker of the two guards. Hence only states from which no
 * statement can ever succeed: a transient failure must never match, because the
 * response is to delete the user's data.
 */
const CORRUPTION_TOKENS = ["sqlite_corrupt", "not a database"] as const;

function isCorruption(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  return CORRUPTION_TOKENS.some((token) => message.includes(token));
}

/**
 * Removes the database and its sidecars.
 *
 * wa-sqlite keeps `-wal` and `-journal` as sibling OPFS entries, so deleting
 * only the main file would leave a reset reopening onto the old journal. The
 * caller must have closed the database first — OPFS answers `removeEntry` with
 * `NoModificationAllowedError` while a sync access handle is still open.
 */
async function removeOpfsDatabase(): Promise<void> {
  const root = await navigator.storage?.getDirectory?.();
  if (!root) return;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await root.removeEntry(`${DATABASE_NAME}${suffix}`);
    } catch (error) {
      // Absent is the desired end state, so `NotFoundError` is success.
      // Anything else — notably `NoModificationAllowedError`, raised while a
      // sync access handle is still open — means the file is still on disk, and
      // swallowing it would let the caller report a recovery that did not
      // happen and then retry against the same corrupt database.
      if ((error as DOMException | undefined)?.name !== "NotFoundError") {
        throw error;
      }
    }
  }
}

/**
 * Upstream's coordinator strands a collection's first sync for ~30s when it
 * starts during boot: the RPC-issuing methods branch on `isLeader` at call
 * time, so a call that lands in the gap between requesting the Web Lock and
 * being granted it goes out as a follower RPC over BroadcastChannel — which
 * never delivers to its own sender. Milliseconds later this tab IS the
 * leader, but the in-flight RPC can no longer be answered by anyone, and it
 * burns the full retry budget (3 × 10s) before upstream falls back. A boot
 * directly into a workspace creates collections mid-render-storm, so the
 * settings read that gates the entry URL hit this every time (MET-135).
 *
 * Fix at our seam, public interface only: hold each RPC-capable call until
 * leadership is SETTLED — this tab won the lock, or a live leader's
 * heartbeat proves the RPC will be answered. The ceiling keeps upstream's
 * own timeout path as the worst case (liveness fallback, never an
 * arbitration of truth), for the day a lock is wedged by a zombie holder.
 */
const LEADERSHIP_SETTLE_CEILING_MS = 10_000;
const LEADERSHIP_POLL_MS = 25;

class SettledLeadershipCoordinator extends BrowserCollectionCoordinator {
  private readonly leaderKnown = new Map<string, Promise<void>>();

  private whenLeaderKnown(collectionId: string): Promise<void> {
    let known = this.leaderKnown.get(collectionId);
    if (!known) {
      known = new Promise<void>((resolve) => {
        // `subscribe` also kicks this tab's own leadership acquisition;
        // any non-RPC envelope (heartbeats included) proves a live leader.
        const unsubscribe = this.subscribe(collectionId, () => done());
        const done = () => {
          clearInterval(poll);
          clearTimeout(ceiling);
          unsubscribe();
          resolve();
        };
        // Self-leadership has no event to listen for — poll for liveness.
        const poll = setInterval(() => {
          if (this.isLeader(collectionId)) done();
        }, LEADERSHIP_POLL_MS);
        const ceiling = setTimeout(done, LEADERSHIP_SETTLE_CEILING_MS);
        if (this.isLeader(collectionId)) done();
      });
      this.leaderKnown.set(collectionId, known);
    }
    return known;
  }

  override async pullSince(
    collectionId: string,
    fromRowVersion: number,
  ): Promise<PullSinceResponse> {
    await this.whenLeaderKnown(collectionId);
    return super.pullSince(collectionId, fromRowVersion);
  }

  override async requestEnsureRemoteSubset(
    collectionId: string,
    options: LoadSubsetOptions,
  ): Promise<void> {
    await this.whenLeaderKnown(collectionId);
    return super.requestEnsureRemoteSubset(collectionId, options);
  }

  override async requestEnsurePersistedIndex(
    collectionId: string,
    signature: string,
    spec: PersistedIndexSpec,
  ): Promise<void> {
    await this.whenLeaderKnown(collectionId);
    return super.requestEnsurePersistedIndex(collectionId, signature, spec);
  }

  override async requestApplyLocalMutations(
    collectionId: string,
    mutations: Array<PersistedMutationEnvelope>,
  ): Promise<ApplyLocalMutationsResponse> {
    await this.whenLeaderKnown(collectionId);
    return super.requestApplyLocalMutations(collectionId, mutations);
  }
}

/** Both browser adapters share one OPFS database, so this is created once. */
export function createBrowserDb(): DbSurface {
  let openPromise: Promise<BrowserWASQLiteDatabase> | null = null;
  let resetInFlight: Promise<void> | null = null;
  let persistence: PersistedCollectionPersistence | null = null;

  const open = (): Promise<BrowserWASQLiteDatabase> => {
    openPromise ??= (async () => {
      // At first use rather than at boot — the result gates nothing.
      await navigator.storage?.persist?.().catch(() => false);
      return openBrowserWASQLiteOPFSDatabase({ databaseName: DATABASE_NAME });
    })().catch((error: unknown) => {
      // Never cache a failed open. OPFS is transiently unavailable often
      // enough — a sync access handle still held by a closing tab, a worker
      // that lost a race at startup — and a retained rejection would make
      // every later query fail until the page reloads.
      openPromise = null;
      throw error;
    });
    return openPromise;
  };

  /** DESTRUCTIVE RECOVERY — same shape as the desktop side. */
  const reset = (): Promise<void> => {
    resetInFlight ??= (async () => {
      console.error(
        "The local database was unreadable and has been recreated. Anything it held is gone.",
      );
      captureEvent("db_corruption_reset", { platform: "browser" });
      try {
        const database = await openPromise;
        await database?.close?.();
      } catch {
        // A database too broken to close is the case being handled.
      }
      openPromise = null;
      try {
        await removeOpfsDatabase();
      } finally {
        resetInFlight = null;
      }
    })();
    return resetInFlight;
  };

  const database: BrowserWASQLiteDatabase = {
    async execute<TRow = unknown>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<ReadonlyArray<TRow>> {
      const run = async () => {
        const handle = await open();
        return handle.execute<TRow>(sql, params);
      };
      try {
        return await run();
      } catch (error) {
        if (!isCorruption(error)) throw error;
        await reset();
        return run();
      }
    },
    async close(): Promise<void> {
      const handle = await openPromise;
      await handle?.close?.();
      openPromise = null;
    },
  };

  return {
    get(): PersistedCollectionPersistence {
      // Memoized for the same reason as the desktop side: one driver means one
      // statement queue, and two queues over one file could interleave.
      persistence ??= createBrowserWASQLitePersistence({
        database,
        // MET-117 deferred multi-tab coordination as extra work. It is one
        // line, and the shipped docs rate its absence as concurrent tabs
        // *corrupting* the database — disqualifying here specifically because
        // the guard above responds to corruption by deleting the file. Leader
        // election runs over Web Locks + BroadcastChannel, both of which die
        // with the page, so there is nothing to dispose.
        coordinator: new SettledLeadershipCoordinator({ dbName: "notefig" }),
        schemaMismatchPolicy: "reset",
      });
      return persistence;
    },
  };
}
