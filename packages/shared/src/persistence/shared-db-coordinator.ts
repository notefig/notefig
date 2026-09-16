/**
 * Coordination for several processes writing one SQLite file: the desktop app
 * and any number of CLI runs sharing `notefig.db`.
 *
 * Why a coordinator at all. The persistence library numbers every write with
 * a stream position (term, seq), computed from the writer's own in-memory
 * view, and `applyCommittedTx` silently skips a write whose (term, seq) is
 * already on disk. Two processes with the default single-process coordinator
 * therefore hand out the same numbers, and the second one's writes vanish
 * without an error — measured: two processes writing 50 task rows each left
 * 51 of 101 on disk, and neither could see the other's.
 *
 * Why this shape, and not the library's own multi-writer design. Its browser
 * coordinator elects a leader per collection and routes every other writer's
 * mutations to it over RPC. Across a webview and a Node process that means
 * election, heartbeats, an RPC transport both can reach, and leadership
 * handoff when the leader dies mid-turn. None of it is needed, because SQLite
 * already has a cross-process leader: the write lock. Both drivers open write
 * transactions with `BEGIN IMMEDIATE`, so:
 *
 *   Writes. Each process allocates its stream position inside the same
 *   immediate transaction as the write, from a counter table. SQLite
 *   serializes the transactions across every process, so positions are
 *   contiguous in commit order and can never collide.
 *
 *   Reads. Each process polls that counter table. When a collection's
 *   counter has moved past what this process has seen, it reads the rows
 *   changed since, as they are now, and delivers them as an ordinary commit.
 *
 * Four rules make delivery correct. Each was found as a real failure — two in
 * a two-process repro, two by the desktop's own test suite — and they are why
 * the code below reads the way it does:
 *
 *   1. Own writes do not move the collection's position directly. The library
 *      applies a write response's position without a gap check, so reporting
 *      the real position would jump past commits another process made in
 *      between, and the collection would later discard those as already
 *      seen. The response carries a position that moves nothing; the real
 *      one arrives as a delivered commit, through the gap check.
 *   2. Read the counter before the rows. A commit landing between the two
 *      reads is then in the rows but not the counter (picked up again later,
 *      harmless), never in the counter but not the rows (skipped for good).
 *   3. Own commits carry no rows. The collection already holds them (the
 *      library confirms a persisted write itself), and a delivered message is
 *      applied later, on the collection's queue: rows in it can land after a
 *      newer local write.
 *   4. Never reload by truncating. TanStack DB keeps a locally written row in
 *      its optimistic layer after the write is confirmed, and a truncate
 *      re-applies that layer: a row this process inserted and another process
 *      deleted comes straight back. So other processes' changes arrive as
 *      targeted updates and deletes, with values read from the table as they
 *      are now — not replayed from the library's transaction log, which is
 *      pruned (after a day, or a thousand commits) and then answers only with
 *      a full reload. A normal sync commit also recomputes the optimistic
 *      layer, which is what clears the stale entry.
 *
 * What this does not arbitrate: two processes writing the same row within one
 * poll interval. The collection may then show the older value until that row
 * next changes. Ownership avoids it rather than this module resolving it — a
 * task row is written only by the process that owns it, and settings only by
 * the app — so it is a boundary to keep, not a case handled here.
 *
 * This relies on library internals, pinned at 0.2.9 and covered by the
 * two-process test and the desktop's two-connection test: `runInTransaction`
 * and `driver` on the SQLite adapter, a transaction driver whose nested
 * transactions become savepoints, the registry and table layout read below,
 * and rules 1 and 4's reading of how positions and truncates are applied.
 * Revisit all of them on any upgrade.
 */
import {
  createSQLiteCorePersistenceAdapter,
  decodePersistedStorageKey,
  safeRandomUUID,
  type ApplyLocalMutationsResponse,
  type PersistedCollectionCoordinator,
  type PersistedCollectionPersistence,
  type PersistedMutationEnvelope,
  type PersistenceAdapter,
  type ProtocolEnvelope,
  type PullSinceResponse,
  type SQLiteDriver,
} from "@tanstack/db-sqlite-persistence-core";

/** Every writer uses one term: positions come from the database, not from
 *  whoever holds leadership, so there is no leadership epoch to count. It is
 *  also the term the single-process coordinator wrote, so existing rows line
 *  up. */
const TERM = 1;

/** How often other processes' commits are looked for. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** The counter table: one row per collection, the last position handed out. */
const STREAM_TABLE = "notefig_stream";

/**
 * The adapter internals this coordinator uses. Not part of the library's
 * published types; see the module comment.
 */
type SQLiteAdapterInternals = PersistenceAdapter & {
  driver: SQLiteDriver;
  scanRows: NonNullable<PersistenceAdapter["scanRows"]>;
  runInTransaction<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T>;
  schemaVersion?: number;
  schemaMismatchPolicy?: string;
  appliedTxPruneMaxRows?: number;
  appliedTxPruneMaxAgeSeconds?: number;
  pullSinceReloadThreshold?: number;
};

/**
 * The configuration fields the join adapter copies from its base (see
 * `joinAdapterFor`). Checked by presence, not value: `schemaVersion` is
 * legitimately undefined, but the adapter assigns every one of these in its
 * constructor, so a missing property means the library renamed it — and a
 * renamed field would otherwise read as undefined and quietly fall back to a
 * library default.
 */
const COPIED_CONFIG_FIELDS = [
  "schemaVersion",
  "schemaMismatchPolicy",
  "appliedTxPruneMaxRows",
  "appliedTxPruneMaxAgeSeconds",
  "pullSinceReloadThreshold",
] as const;

function asInternals(adapter: PersistenceAdapter): SQLiteAdapterInternals {
  const candidate = adapter as Partial<SQLiteAdapterInternals>;
  const missing = [
    typeof candidate.runInTransaction !== "function" && "runInTransaction",
    !candidate.driver && "driver",
    typeof candidate.scanRows !== "function" && "scanRows",
    ...COPIED_CONFIG_FIELDS.filter((field) => !(field in candidate)),
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) {
    throw new Error(
      `SharedDbCoordinator relies on SQLite core adapter internals that are ` +
        `missing (${missing.join(", ")}); the persistence library changed. ` +
        `See the module comment in shared-db-coordinator.ts before upgrading.`,
    );
  }
  return candidate as SQLiteAdapterInternals;
}

type Seen = { seq: number; rowVersion: number };

type TxCommittedPayload = {
  type: "tx:committed";
  term: number;
  seq: number;
  txId: string;
  latestRowVersion: number;
  requiresFullReload: boolean;
  changedRows: Array<{ key: string | number; value: unknown }>;
  deletedKeys: Array<string | number>;
};

export type SharedDbCoordinatorOptions = {
  pollIntervalMs?: number;
  /** Where poll failures are reported. Defaults to console.warn. */
  warn?: (message: string, error: unknown) => void;
};

export class SharedDbCoordinator implements PersistedCollectionCoordinator {
  private readonly nodeId = safeRandomUUID();
  private readonly pollIntervalMs: number;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly adapters = new Map<string, SQLiteAdapterInternals>();
  /** One join adapter per base adapter; see `joinAdapterFor`. */
  private readonly joinAdapters = new Map<
    SQLiteAdapterInternals,
    { adapter: SQLiteAdapterInternals; bind: (tx: SQLiteDriver | null) => void }
  >();
  private readonly subscribers = new Map<
    string,
    Set<(message: ProtocolEnvelope<unknown>) => void>
  >();
  private readonly seen = new Map<string, Seen>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastPollError: string | null = null;
  private disposed = false;

  constructor(options: SharedDbCoordinatorOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.warn =
      options.warn ?? ((message, error) => console.warn(message, error));
  }

  /**
   * Wrap a persistence so every collection built on it registers its adapter
   * here. The coordinator is handed only a collection id by the library, and
   * the adapter differs per schema version, so this is where it learns which
   * adapter a collection writes through.
   */
  coordinate(
    persistence: PersistedCollectionPersistence,
  ): PersistedCollectionPersistence {
    const resolve = persistence.resolvePersistenceForCollection;
    if (!resolve) {
      throw new Error(
        "SharedDbCoordinator needs a persistence that resolves per collection.",
      );
    }
    return {
      ...persistence,
      coordinator: this,
      resolvePersistenceForCollection: (options) => {
        const resolved = resolve(options);
        this.adapters.set(options.collectionId, asInternals(resolved.adapter));
        return { ...resolved, coordinator: this };
      },
    };
  }

  getNodeId(): string {
    return this.nodeId;
  }

  isLeader(): boolean {
    // Every process writes for itself; SQLite's write lock is the leader.
    return true;
  }

  async ensureLeadership(): Promise<void> {}

  async requestEnsureRemoteSubset(): Promise<void> {}

  async requestEnsurePersistedIndex(): Promise<void> {}

  subscribe(
    collectionId: string,
    onMessage: (message: ProtocolEnvelope<unknown>) => void,
  ): () => void {
    let set = this.subscribers.get(collectionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(collectionId, set);
    }
    set.add(onMessage);
    // Polling starts with the first subscriber, not at construction: a
    // subscriber means a collection is in use, and until then no query may
    // run — the desktop creates notefig.db on the first statement, and a
    // user who never persists anything must never get one.
    this.startPolling();
    return () => {
      set?.delete(onMessage);
    };
  }

  publish(collectionId: string, message: ProtocolEnvelope<unknown>): void {
    this.deliver(collectionId, message);
  }

  async requestApplyLocalMutations(
    collectionId: string,
    mutations: Array<PersistedMutationEnvelope>,
  ): Promise<ApplyLocalMutationsResponse> {
    const base = this.adapterFor(collectionId);
    const join = this.joinAdapterFor(base);

    const committed = await base.runInTransaction(async (tx) => {
      // Inside BEGIN IMMEDIATE: no other process can write until this
      // commits, so the position read here is the position this write takes.
      join.bind(tx);
      try {
        await tx.run(
          `CREATE TABLE IF NOT EXISTS ${STREAM_TABLE} (
             collection_id TEXT PRIMARY KEY,
             seq INTEGER NOT NULL
           )`,
        );
        const [counter] = await tx.query<{ seq: number }>(
          `SELECT seq FROM ${STREAM_TABLE} WHERE collection_id = ?`,
          [collectionId],
        );
        // applied_tx covers databases written before this coordinator existed.
        const [applied] = await tx.query<{ seq: number | null }>(
          `SELECT MAX(seq) AS seq FROM applied_tx WHERE collection_id = ?`,
          [collectionId],
        );
        const seq = Math.max(counter?.seq ?? 0, applied?.seq ?? 0) + 1;
        await tx.run(
          `INSERT INTO ${STREAM_TABLE} (collection_id, seq) VALUES (?, ?)
           ON CONFLICT(collection_id) DO UPDATE SET seq = excluded.seq`,
          [collectionId, seq],
        );

        const txId = safeRandomUUID();
        // The join adapter's own transaction nests into this one as a
        // savepoint, so the position and the rows commit together.
        await join.adapter.applyCommittedTx(collectionId, {
          txId,
          term: TERM,
          seq,
          rowVersion: 0,
          mutations: mutations.map((mutation) => ({
            type: mutation.type,
            key: mutation.key,
            value: mutation.value,
          })) as never,
        });
        const [version] = await tx.query<{ latest_row_version: number }>(
          `SELECT latest_row_version FROM collection_version WHERE collection_id = ?`,
          [collectionId],
        );
        return { seq, txId, rowVersion: version?.latest_row_version ?? 0 };
      } finally {
        join.bind(null);
      }
    });

    // Rule 1 (module comment). This process's own bookkeeping only advances
    // when the write was contiguous with what it had seen; otherwise the next
    // poll pulls from the older row version and collects what it missed.
    const seen = this.seenFor(collectionId);
    if (committed.seq === seen.seq + 1) {
      this.observe(collectionId, committed.seq, committed.rowVersion);
    }
    this.deliver(
      collectionId,
      this.envelope(collectionId, {
        type: "tx:committed",
        term: TERM,
        seq: committed.seq,
        txId: committed.txId,
        latestRowVersion: committed.rowVersion,
        requiresFullReload: false,
        // Rule 3: no rows. This process's collection already holds them.
        changedRows: [],
        deletedKeys: [],
      }),
    );

    return {
      type: "rpc:applyLocalMutations:res",
      rpcId: safeRandomUUID(),
      ok: true,
      // A position that moves nothing; the delivered commit carries the real one.
      term: TERM,
      seq: 0,
      latestRowVersion: 0,
      acceptedMutationIds: mutations.map((mutation) => mutation.mutationId),
    };
  }

  async pullSince(
    collectionId: string,
    fromRowVersion: number,
  ): Promise<PullSinceResponse> {
    const base = this.adapterFor(collectionId);
    // Rule 2: the counter first.
    const seq = await this.readSeq(base, collectionId);
    const changes = await this.readChangesSince(base, collectionId, fromRowVersion);
    // Rule 4: one delta of current rows, never a full reload.
    return {
      type: "rpc:pullSince:res",
      rpcId: safeRandomUUID(),
      ok: true,
      latestTerm: TERM,
      latestSeq: seq,
      latestRowVersion: changes.rowVersion,
      requiresFullReload: false,
      changedKeys: changes.changedRows.map((row) => row.key),
      deletedKeys: changes.deletedKeys,
      deltas: [
        {
          txId: safeRandomUUID(),
          latestRowVersion: changes.rowVersion,
          changedRows: changes.changedRows,
          deletedKeys: changes.deletedKeys,
          rowMetadataMutations: [],
          collectionMetadataMutations: [],
        },
      ],
    } as PullSinceResponse;
  }

  /** Stop polling. Collections built on this coordinator stop hearing about
   *  other processes' writes; their own writes still work. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------

  private adapterFor(collectionId: string): SQLiteAdapterInternals {
    const adapter = this.adapters.get(collectionId);
    if (!adapter) {
      throw new Error(
        `SharedDbCoordinator: collection "${collectionId}" was not built on ` +
          `a persistence passed through coordinate()`,
      );
    }
    return adapter;
  }

  /**
   * An adapter over the current transaction, so the library's write runs
   * inside the coordinator's immediate transaction instead of queueing
   * behind it (which would deadlock the desktop driver's statement queue).
   *
   * Cached per base adapter with a driver that forwards to whichever
   * transaction is bound. Unambiguous because the base driver runs one
   * transaction at a time, and the binding is set and cleared inside it.
   */
  private joinAdapterFor(base: SQLiteAdapterInternals): {
    adapter: SQLiteAdapterInternals;
    bind: (tx: SQLiteDriver | null) => void;
  } {
    const cached = this.joinAdapters.get(base);
    if (cached) return cached;

    let current: SQLiteDriver | null = null;
    const bound = (): SQLiteDriver => {
      if (!current) {
        throw new Error(
          "SharedDbCoordinator: join adapter used outside its transaction",
        );
      }
      return current;
    };
    const driver: SQLiteDriver = {
      exec: (sql) => bound().exec(sql),
      query: (sql, params) => bound().query(sql, params),
      run: (sql, params) => bound().run(sql, params),
      transaction: (fn) => bound().transaction(fn),
      transactionWithDriver: (fn) => {
        const tx = bound();
        return tx.transactionWithDriver
          ? tx.transactionWithDriver(fn)
          : tx.transaction(fn);
      },
    };
    const adapter = asInternals(
      createSQLiteCorePersistenceAdapter({
        driver,
        schemaVersion: base.schemaVersion,
        schemaMismatchPolicy: base.schemaMismatchPolicy as never,
        appliedTxPruneMaxRows: base.appliedTxPruneMaxRows,
        appliedTxPruneMaxAgeSeconds: base.appliedTxPruneMaxAgeSeconds,
        pullSinceReloadThreshold: base.pullSinceReloadThreshold,
      }) as unknown as PersistenceAdapter,
    );
    const join = {
      adapter,
      bind: (tx: SQLiteDriver | null) => {
        current = tx;
      },
    };
    this.joinAdapters.set(base, join);
    return join;
  }

  private seenFor(collectionId: string): Seen {
    return this.seen.get(collectionId) ?? { seq: 0, rowVersion: 0 };
  }

  private observe(collectionId: string, seq: number, rowVersion: number): void {
    const previous = this.seenFor(collectionId);
    this.seen.set(collectionId, {
      seq: Math.max(previous.seq, seq),
      rowVersion: Math.max(previous.rowVersion, rowVersion),
    });
  }

  private async readSeq(
    adapter: SQLiteAdapterInternals,
    collectionId: string,
  ): Promise<number> {
    const counters = await this.readCounters(adapter);
    return counters.get(collectionId) ?? 0;
  }

  /**
   * The rows changed since a row version, as they are now, and the keys
   * deleted since. Read from the collection's own table and tombstones, which
   * are never pruned, rather than the transaction log, which is (rule 4).
   */
  private async readChangesSince(
    adapter: SQLiteAdapterInternals,
    collectionId: string,
    fromRowVersion: number,
  ): Promise<{
    rowVersion: number;
    changedRows: Array<{ key: string | number; value: unknown }>;
    deletedKeys: Array<string | number>;
  }> {
    const rowVersion = await this.readRowVersion(adapter, collectionId);
    const [registry] = await adapter.driver.query<{
      table_name: string;
      tombstone_table_name: string;
    }>(
      `SELECT table_name, tombstone_table_name FROM collection_registry WHERE collection_id = ?`,
      [collectionId],
    );
    if (!registry) return { rowVersion, changedRows: [], deletedKeys: [] };

    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const [changed, deleted] = await Promise.all([
      adapter.driver.query<{ key: string }>(
        `SELECT key FROM ${quote(registry.table_name)} WHERE row_version > ?`,
        [fromRowVersion],
      ),
      adapter.driver.query<{ key: string }>(
        `SELECT key FROM ${quote(registry.tombstone_table_name)} WHERE row_version > ?`,
        [fromRowVersion],
      ),
    ]);
    const changedKeys = new Set(
      changed.map((row) => String(decodePersistedStorageKey(row.key))),
    );
    // Decoded values come from the adapter itself; the key set above filters
    // them to what changed.
    const changedRows =
      changedKeys.size === 0
        ? []
        : (await adapter.scanRows(collectionId))
            .filter((row) => changedKeys.has(String(row.key)))
            .map((row) => ({ key: row.key, value: row.value }));
    return {
      rowVersion,
      changedRows,
      deletedKeys: deleted.map((row) => decodePersistedStorageKey(row.key)),
    };
  }

  private async readRowVersion(
    adapter: SQLiteAdapterInternals,
    collectionId: string,
  ): Promise<number> {
    const [row] = await adapter.driver.query<{ latest_row_version: number }>(
      `SELECT latest_row_version FROM collection_version WHERE collection_id = ?`,
      [collectionId],
    );
    return row?.latest_row_version ?? 0;
  }

  private async readCounters(
    adapter: SQLiteAdapterInternals,
  ): Promise<Map<string, number>> {
    try {
      const rows = await adapter.driver.query<{
        collection_id: string;
        seq: number;
      }>(`SELECT collection_id, seq FROM ${STREAM_TABLE}`);
      return new Map(rows.map((row) => [row.collection_id, row.seq]));
    } catch (error) {
      // No coordinated write has happened yet, so the table does not exist.
      if (/no such table/i.test(String((error as Error)?.message ?? error))) {
        return new Map();
      }
      throw error;
    }
  }

  private startPolling(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    // Never the reason a CLI process stays alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    const collectionIds = [...this.subscribers.keys()].filter((id) =>
      this.adapters.has(id),
    );
    if (collectionIds.length === 0) return;
    this.polling = true;
    try {
      // Every collection here shares one database, so one counter read covers
      // them all; any adapter's driver can make it.
      const counters = await this.readCounters(
        this.adapterFor(collectionIds[0]),
      );
      for (const collectionId of collectionIds) {
        const seq = counters.get(collectionId) ?? 0;
        const seen = this.seenFor(collectionId);
        if (seq <= seen.seq) continue;
        const base = this.adapterFor(collectionId);
        // The counter was read above, so these rows are at least that new
        // (rule 2), read as they are now (rule 4).
        const changes = await this.readChangesSince(
          base,
          collectionId,
          seen.rowVersion,
        );
        this.observe(collectionId, seq, changes.rowVersion);
        // The real position. Missed more than one commit: the collection sees
        // a gap and recovers through pullSince, which reads the same way.
        this.deliver(
          collectionId,
          this.envelope(collectionId, {
            type: "tx:committed",
            term: TERM,
            seq,
            txId: safeRandomUUID(),
            latestRowVersion: changes.rowVersion,
            requiresFullReload: false,
            changedRows: changes.changedRows,
            deletedKeys: changes.deletedKeys,
          }),
        );
      }
      this.lastPollError = null;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // Once per distinct failure, not once per tick.
      if (message !== this.lastPollError) {
        this.lastPollError = message;
        this.warn("Shared database poll failed:", error);
      }
    } finally {
      this.polling = false;
    }
  }

  private deliver(
    collectionId: string,
    message: ProtocolEnvelope<unknown>,
  ): void {
    for (const subscriber of this.subscribers.get(collectionId) ?? []) {
      subscriber(message);
    }
  }

  private envelope(
    collectionId: string,
    payload: TxCommittedPayload,
  ): ProtocolEnvelope<unknown> {
    return {
      v: 1,
      dbName: "notefig",
      collectionId,
      senderId: this.nodeId,
      ts: Date.now(),
      payload,
    };
  }
}
