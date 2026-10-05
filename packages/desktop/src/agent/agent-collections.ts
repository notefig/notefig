/**
 * The agent store — `core.agentStore`: TanStack DB collections for agent
 * task state, built from the persistence core hands it. Every row is keyed
 * to a task — parallelism is structural, not bolted on. Turns, entries and
 * permission requests are ephemeral (per app run); task rows persist. UI
 * consumes them with useLiveQuery, the same idiom as the file collections.
 */
import {
  BasicIndex,
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import type {
  AgentEntry,
  AgentPermissionRequestRow,
  AgentTaskRow,
  AgentTaskStatus,
  AgentTurn,
} from "@notefig/shared/agent";
import {
  AGENT_TASKS_COLLECTION_ID,
  bootAgentTaskRow,
  parsePersistedAgentTask,
} from "./agent-persistence";
import { defineModule } from "@notefig/core";
import { useModule } from "@notefig/core/react";

// The row shapes live in @notefig/shared/agent — @notefig/widgets derives the
// prompt widget's state machine from turns and entries, and neither package
// owns the other. Writing them is still this module's job alone. Re-exported
// so the app's existing "rows come from agent-collections" imports stand.
export type {
  AgentEntry,
  AgentEntryType,
  AgentPermissionRequestRow,
  AgentTaskRow,
  AgentTaskStatus,
  AgentTurn,
  AgentTurnStatus,
} from "@notefig/shared/agent";

const AGENT_TASK_STATUSES = new Set<string>([
  "starting",
  "idle",
  "running",
  "cancelled",
  "error",
  "restored",
  "unavailable",
] satisfies AgentTaskStatus[]);

function isAgentTaskStatus(value: string): value is AgentTaskStatus {
  return AGENT_TASK_STATUSES.has(value);
}

function createAgentTasksCollection(
  persistence: PersistedCollectionPersistence,
) {
  /**
   * Persisted (MET-54, on SQLite since MET-124): a local-only collection
   * whose source of truth is the `db` surface. Every mutation is committed
   * by the persistence wrapper, and the rows come back on the next launch —
   * so there is no mirror, no restore step and no dispose bookkeeping.
   *
   * Two behavioral notes, both consequences of that wrapper:
   *
   * - Persistence is no longer best-effort. The old KV write-through
   *   swallowed failures so a doomed disk write could not roll back an
   *   optimistic mutation and visibly revert a task's status under a
   *   still-running runtime. The wrapper commits after our handlers and its
   *   throw is not interceptable, so a failed write now rolls the mutation
   *   back. The realistic failure modes are corruption — which the
   *   adapter's guard resets and retries (MET-123) — and a full disk.
   * - Rows load raw. The old `queryFn` reconciled stored rows against the
   *   live task registry as it read them; that now happens once,
   *   explicitly, in `reconcile` below.
   */
  return createCollection(
    persistedCollectionOptions<AgentTaskRow, string>({
      id: AGENT_TASKS_COLLECTION_ID,
      getKey: (task) => task.taskId,
      persistence,
    }),
  );
}

/** Whether a hydrated row already matches what the boot mapping would produce. */
function matchesBootRow(row: AgentTaskRow, boot: AgentTaskRow): boolean {
  // `undefined` counts as absent: that is how a stripped field looks in memory
  const significant = (task: AgentTaskRow) =>
    Object.entries(task).filter(
      ([key, value]) => !key.startsWith("$") && value !== undefined,
    );
  const rowEntries = significant(row);
  const bootEntries = significant(boot);
  if (rowEntries.length !== bootEntries.length) return false;
  return bootEntries.every(
    ([key, value]) => row[key as keyof AgentTaskRow] === value,
  );
}

export type AgentTasksCollection = ReturnType<
  typeof createAgentTasksCollection
>;

export interface AgentStore {
  readonly tasks: AgentTasksCollection;
  readonly turns: ReturnType<typeof createTurnsCollection>;
  readonly entries: ReturnType<typeof createEntriesCollection>;
  readonly permissionRequests: ReturnType<
    typeof createPermissionRequestsCollection
  >;
  entriesForTask(taskId: string): AgentEntry[];
  turnsForTask(taskId: string): AgentTurn[];
  /** The live target: entries land in the collections as they stream. */
  readonly liveEntryWriter: AgentEntryWriter;
  /** A fresh staging target for one session/load replay. */
  replayStage(): ReplayStage;
  /**
   * Bring hydrated task rows in line with this session's reality, given
   * the status of each task that has a live runtime. Idempotent.
   *
   * The rules are the ones the pre-MET-124 `queryFn` applied as it read:
   *
   * - a task with a live runtime keeps its stored row, since write-through
   *   keeps storage current — except `status`, which the schema only
   *   validates as a string; a value outside the union falls back to the
   *   runtime's own rather than entering it unchecked
   * - without a runtime but with a session, the row demotes to "restored"
   *   and sheds runtime-only fields; the first interaction revives it via
   *   session/load
   * - without a session there is nothing to revive, so the row is deleted.
   *   The old code merely skipped these on read, which left them in
   *   storage forever.
   * - a row that fails validation is deleted for the same reason it was
   *   dropped before: it must never reach revival or spawn.
   */
  reconcile(
    liveStatus: (taskId: string) => AgentTaskStatus | undefined,
  ): Promise<void>;
  /** Drop one task's rows from every collection. */
  purgeTask(taskId: string): void;
}

function createTurnsCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "agent-turns",
      getKey: (turn: AgentTurn) => turn.turnId,
    }),
  );
}

function createEntriesCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "agent-entries",
      getKey: (entry: AgentEntry) => entry.id,
    }),
  );
}

function createPermissionRequestsCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "agent-permission-requests",
      getKey: (request: AgentPermissionRequestRow) => request.id,
    }),
  );
}

export function createAgentStore(
  persistence: PersistedCollectionPersistence,
): AgentStore {
  const tasks = createAgentTasksCollection(persistence);
  const turns = createTurnsCollection();
  const entries = createEntriesCollection();
  const permissionRequests = createPermissionRequestsCollection();

  /**
   * Collection-maintained taskId indexes. The service's maintenance passes
   * (replay purge, lingering-tool resolution, task-row purge) would
   * otherwise full-scan entries/turns — collections that now grow with
   * replayed history across every task in the workspace. `eq(taskId)` live
   * queries pick these up through the query planner for free.
   */
  const entriesByTask = entries.createIndex((entry) => entry.taskId, {
    indexType: BasicIndex,
  });
  const turnsByTask = turns.createIndex((turn) => turn.taskId, {
    indexType: BasicIndex,
  });

  const entriesForTask = (taskId: string): AgentEntry[] => {
    const found: AgentEntry[] = [];
    for (const key of entriesByTask.equalityLookup(taskId)) {
      const entry = entries.get(String(key));
      if (entry) found.push(entry);
    }
    return found;
  };

  const turnsForTask = (taskId: string): AgentTurn[] => {
    const found: AgentTurn[] = [];
    for (const key of turnsByTask.equalityLookup(taskId)) {
      const turn = turns.get(String(key));
      if (turn) found.push(turn);
    }
    return found;
  };

  const store: AgentStore = {
    tasks,
    turns,
    entries,
    permissionRequests,
    entriesForTask,
    turnsForTask,
    liveEntryWriter: {
      insert: (row) => entries.insert({ ...row, createdAt: Date.now() }),
      update: (id, mutate) => entries.update(id, mutate),
      delete: (id) => entries.delete(id),
      entriesForTask,
    },
    replayStage: () => new ReplayStage(store),
    async reconcile(liveStatus) {
      await tasks.preload();

      for (const row of [...tasks.values()]) {
        const stored = parsePersistedAgentTask(row);
        if (!stored) {
          await tasks.delete(row.taskId).isPersisted.promise;
          continue;
        }

        const status = liveStatus(stored.taskId);
        if (status) {
          if (!isAgentTaskStatus(stored.status)) {
            await tasks.update(stored.taskId, (draft) => {
              draft.status = status;
            }).isPersisted.promise;
          }
          continue;
        }

        const boot = bootAgentTaskRow(stored);
        if (!boot) {
          await tasks.delete(stored.taskId).isPersisted.promise;
          continue;
        }
        if (matchesBootRow(row, boot)) continue;
        // Replace rather than patch: the mapping drops runtime-only fields
        // (authHint, authMethods, …), and a draft mutation can only add or
        // change. Each step is awaited to durability so the next launch
        // cannot observe a half-applied replacement.
        await tasks.update(stored.taskId, (draft) => {
          Object.assign(draft, boot);
          for (const key of Object.keys(draft)) {
            if (key.startsWith("$") || key in boot) continue;
            (draft as Record<string, unknown>)[key] = undefined;
          }
        }).isPersisted.promise;
      }
    },
    purgeTask(taskId) {
      for (const entry of entriesForTask(taskId)) entries.delete(entry.id);
      for (const turn of turnsForTask(taskId)) turns.delete(turn.turnId);
      for (const request of permissionRequests.toArray) {
        if (request.taskId === taskId) permissionRequests.delete(request.id);
      }
      if (tasks.get(taskId)) tasks.delete(taskId);
    },
  };
  return store;
}

/**
 * Where a turn's transcript-entry writes land. The streaming pipeline in
 * agent-service is target-agnostic: every turn carries its writer — live
 * turns write straight to the collections ({@link liveEntryWriter}), a
 * session/load replay writes into a {@link ReplayStage} that swaps in
 * atomically when the load completes. The target riding the turn (rather
 * than a mode flag on the task) is what keeps the service free of "are we
 * replaying right now?" state.
 *
 * Deliberately NOT the collections' own sync layer: TanStack DB's sync
 * transactions stage invisibly and land atomically — the right shape — but
 * staged rows aren't readable mid-transaction, and the replay pipeline must
 * read-modify its own staged rows (tool-call coalescing, whitespace-run
 * deletion, the lingering-tool sweep). A readable staging model is
 * irreducible, so it lives here, next to the collections it commits into.
 */
export interface AgentEntryWriter {
  /** Insert one entry. `createdAt` is the writer's call: live writes stamp
   *  wall-clock time; replayed history gets none — ACP carries no
   *  timestamps (MET-94), so a replayed entry's true time is unknowable and
   *  a revival-time stamp would lie. Ordering never depends on the stamp
   *  (entry ids are mint-ascending). */
  insert(row: Omit<AgentEntry, "createdAt">): void;
  update(id: string, mutate: (draft: AgentEntry) => void): void;
  delete(id: string): void;
  entriesForTask(taskId: string): AgentEntry[];
}

/**
 * Staging target for one session/load replay: history streams in here, NOT
 * the collections, so the rows kept from the task's previous life stay
 * visible while it runs, and {@link commit} swaps them for the replayed
 * transcript in one synchronous pass — a single render, no frame where the
 * transcript is empty or doubled (a wipe-first order rendered, removed, and
 * re-added the same messages). A failed load simply drops the stage,
 * keeping the old transcript readable.
 */
export class ReplayStage implements AgentEntryWriter {
  private readonly rows = new Map<string, AgentEntry>();

  constructor(private readonly store: AgentStore) {}

  insert(row: Omit<AgentEntry, "createdAt">): void {
    this.rows.set(row.id, row);
  }

  update(id: string, mutate: (draft: AgentEntry) => void): void {
    const row = this.rows.get(id);
    if (row) mutate(row);
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  /** Staged rows all belong to the replaying task — no filtering needed. */
  entriesForTask(): AgentEntry[] {
    return [...this.rows.values()];
  }

  /**
   * The atomic swap: drop the task's previous transcript rows and insert
   * the synthetic replay turn plus the staged entries. Turns in
   * `keepTurnIds` (prompts queued against the revival) keep their rows —
   * they aren't part of the replayed history.
   */
  commit(replayTurn: AgentTurn, keepTurnIds: ReadonlySet<string>): void {
    const taskId = replayTurn.taskId;
    for (const entry of this.store.entriesForTask(taskId)) {
      if (!keepTurnIds.has(entry.turnId)) {
        this.store.entries.delete(entry.id);
      }
    }
    for (const turn of this.store.turnsForTask(taskId)) {
      if (!keepTurnIds.has(turn.turnId)) {
        this.store.turns.delete(turn.turnId);
      }
    }
    this.store.turns.insert(replayTurn);
    for (const row of this.rows.values()) {
      this.store.entries.insert(row);
    }
  }
}

declare module "@notefig/core" {
  interface CoreModules {
    agentStore: AgentStore;
  }
}

/** The agent collections, over the platform's database. */
export const agentStoreModule = defineModule({
  name: "agentStore",
  needs: ["platform"],
  register: (ctx) => createAgentStore(ctx.use("platform").db.get()),
});

/** The agent store, for components. */
export function useAgentStore(): AgentStore {
  return useModule("agentStore");
}
