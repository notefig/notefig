/**
 * Local-only TanStack DB collections for agent task state. Every row is
 * keyed to a task — parallelism is structural, not bolted on. These are
 * ephemeral (per app run) — durable history arrives in Phase 4 via ACP
 * session/load + KV transcript fallback. UI consumes them with
 * useLiveQuery, the same idiom as the file collections.
 */
import {
  BasicIndex,
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import type { AuthMethod, ToolCallUpdate } from "@notefig/shared/agent";
import { platformAdapter } from "@/adapters";
import { getRegisteredTask } from "./task-registry";
import {
  AGENT_TASKS_COLLECTION_ID,
  bootAgentTaskRow,
  parsePersistedAgentTask,
} from "./agent-persistence";

export type AgentTaskStatus =
  | "starting"
  | "idle"
  | "running"
  | "cancelled"
  | "error"
  /** Persisted session restored after a restart — live but unspawned; first
   *  interaction revives it via ACP session/load (agent-persistence.ts). */
  | "restored"
  /** Revival failed (harness-side session gone) — read-only, deletable. */
  | "unavailable";

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

export type AgentTaskRow = {
  /** task_ (descending id: newest-first lexicographic sort) */
  taskId: string;
  /** Set when this task was spawned by another task (subagent pattern) */
  parentTaskId?: string;
  workspacePath: string;
  /** Short user-facing label, e.g. first prompt truncated */
  title: string;
  status: AgentTaskStatus;
  harnessId: string;
  /**
   * ACP session id, set once session/new (or session/load) succeeds. Rides
   * the row (not a KV side-key) so persistence and revival read one record.
   */
  sessionId?: string;
  createdAt: number;
  /**
   * Last-activity timestamp: bumped on insert, every status transition, and
   * prompt enqueue (queueing onto a busy task doesn't change status). Drives
   * session-list ordering; deliberately NOT bumped per streamed chunk.
   */
  updatedAt: number;
  /**
   * "How to sign in" hint from the adapter/harness, surfaced on auth errors.
   * On the row (not just the AgentTask instance) so the banner flows through
   * useLiveQuery and can't lag behind an unrelated collection write.
   */
  authHint?: string;
  /**
   * Auth-blocked state is task-row state, not a collection of its own
   * (Stage 4 design). True from a prompt failing with "authentication
   * required" until a turn reaches the model again; `authMethods` carries
   * what `initialize` advertised so the panel can render sign-in affordances
   * straight off the row.
   */
  authRequired?: boolean;
  authMethods?: AuthMethod[];
};

export type AgentTurnStatus =
  "queued" | "running" | "completed" | "cancelled" | "error";

export type AgentTurn = {
  /** trn_ (ascending) — one per session/prompt round-trip */
  turnId: string;
  taskId: string;
  /** Empty while the turn is queued on a task whose session isn't up yet. */
  sessionId: string;
  status: AgentTurnStatus;
  /** ACP stop reason once the turn ends */
  stopReason?: string;
  /** Failure reason when status is "error" — the "why did it fail?" answer. */
  error?: string;
  startedAt: number;
};

export type AgentEntryType =
  | "user"
  | "assistant"
  /** Coalesced agent_thought_chunk run (OpenCode streams these per token). */
  | "thought"
  | "tool_call"
  | "plan"
  | "unknown";

/**
 * One item in a task's transcript — a flat, ordered stream. Text and tool
 * calls are peers (tools are NOT nested under a message), so a
 * text → tool → text sequence renders in the order it happened. Assistant
 * text is coalesced into a contiguous run; a new run starts after each tool
 * call. Ids are minted ascending (newEventId) so lexicographic sort =
 * chronological render order.
 */
export type AgentEntry = {
  /** evt_ (ascending: lexicographic sort = chronological) */
  id: string;
  taskId: string;
  turnId: string;
  type: AgentEntryType;
  /** user / assistant / thought text runs; unknown: the update's sessionUpdate kind */
  text?: string;
  /** tool_call: the ACP toolCallId this row coalesces */
  toolCallId?: string;
  /** tool_call: the coalesced tool call (title, kind, status, content, …) */
  toolCall?: ToolCallUpdate;
  /** plan: raw plan update payload */
  plan?: unknown;
  /** unknown: the full unrecognized session-update payload, kept verbatim
   * (D4) so a later stage can render it (e.g. agent_thought_chunk) for free */
  raw?: unknown;
  /**
   * Wall-clock insert time — absent on session/load replay (MET-94): ACP
   * carries no timestamps, so a replayed entry's true time is unknowable
   * and a revival-time stamp would lie. NEVER use this for ordering — ids
   * are the chronological order, present or not.
   */
  createdAt?: number;
};

export type AgentPermissionRequestRow = {
  id: string;
  taskId: string;
  sessionId: string;
  title: string;
  /** ACP PermissionOption[] rendered verbatim */
  options: unknown[];
  status: "pending" | "granted" | "denied" | "cancelled";
};

/**
 * Persisted (MET-54, on SQLite since MET-124): a local-only collection whose
 * source of truth is the `db` surface. Every mutation is committed by the
 * persistence wrapper, and the rows come back on the next launch — so there is
 * no mirror, no restore step and no dispose bookkeeping.
 *
 * Two behavioral notes, both consequences of that wrapper:
 *
 * - Persistence is no longer best-effort. The old KV write-through swallowed
 *   failures so a doomed disk write could not roll back an optimistic mutation
 *   and visibly revert a task's status under a still-running runtime. The
 *   wrapper commits after our handlers and its throw is not interceptable, so a
 *   failed write now rolls the mutation back. The realistic failure modes are
 *   corruption — which the adapter's guard resets and retries (MET-123) — and a
 *   full disk.
 * - Rows load raw. The old `queryFn` reconciled stored rows against the live
 *   task registry as it read them; that now happens once, explicitly, in
 *   `reconcileAgentTasksAtBoot` below.
 */
export const agentTasksCollection = createCollection(
  persistedCollectionOptions<AgentTaskRow, string>({
    id: AGENT_TASKS_COLLECTION_ID,
    getKey: (task) => task.taskId,
    persistence: platformAdapter.db.get(),
  }),
);

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

/**
 * Bring hydrated rows in line with this session's reality. Runs once at boot
 * (App.tsx), and is idempotent, so a second call is a no-op.
 *
 * The rules are the ones the pre-MET-124 `queryFn` applied as it read:
 *
 * - a task with a live runtime keeps its stored row, since write-through keeps
 *   storage current — except `status`, which the schema only validates as a
 *   string; a value outside the union falls back to the runtime's own rather
 *   than entering it unchecked
 * - without a runtime but with a session, the row demotes to "restored" and
 *   sheds runtime-only fields; the first interaction revives it via session/load
 * - without a session there is nothing to revive, so the row is deleted. The
 *   old code merely skipped these on read, which left them in storage forever.
 * - a row that fails validation is deleted for the same reason it was dropped
 *   before: it must never reach revival or spawn.
 */
export async function reconcileAgentTasksAtBoot(): Promise<void> {
  await agentTasksCollection.preload();

  for (const row of [...agentTasksCollection.values()]) {
    const stored = parsePersistedAgentTask(row);
    if (!stored) {
      await agentTasksCollection.delete(row.taskId).isPersisted.promise;
      continue;
    }

    const task = getRegisteredTask(stored.taskId);
    if (task) {
      if (!isAgentTaskStatus(stored.status)) {
        await agentTasksCollection.update(stored.taskId, (draft) => {
          draft.status = task.currentStatus;
        }).isPersisted.promise;
      }
      continue;
    }

    const boot = bootAgentTaskRow(stored);
    if (!boot) {
      await agentTasksCollection.delete(stored.taskId).isPersisted.promise;
      continue;
    }
    if (matchesBootRow(row, boot)) continue;
    // Replace rather than patch: the mapping drops runtime-only fields
    // (authHint, authMethods, …), and a draft mutation can only add or change.
    // Each step is awaited to durability so the next launch cannot observe a
    // half-applied replacement.
    await agentTasksCollection.update(stored.taskId, (draft) => {
      Object.assign(draft, boot);
      for (const key of Object.keys(draft)) {
        if (key.startsWith("$") || key in boot) continue;
        (draft as Record<string, unknown>)[key] = undefined;
      }
    }).isPersisted.promise;
  }
}

let reconcileStarted = false;
let reconcileSettled: Promise<boolean> | null = null;

/**
 * Fire-and-forget boot trigger, once per app session — StrictMode's
 * double-invoke and remounts are no-ops. Failures are logged, never thrown: a
 * task list that could not be reconciled must not take app startup down.
 */
export function ensureAgentTasksReconciled(): void {
  if (reconcileStarted) return;
  reconcileStarted = true;
  reconcileSettled = reconcileAgentTasksAtBoot().then(
    () => true,
    (error: unknown) => {
      console.warn("Agent task reconciliation failed:", error);
      return false;
    },
  );
}

/**
 * Resolves TRUE once the hydrated rows are trustworthy — i.e. after boot
 * reconciliation has deleted the rows that can never be revived — and FALSE
 * when reconciliation failed and they never became trustworthy.
 *
 * Anything that treats a missing row as "this session is gone for good" must
 * wait for this first: before it settles, the collection is either still
 * loading or still holding rows that are about to be deleted. The false case
 * matters just as much: a failed preload (corrupt or unreadable storage)
 * leaves an empty collection that is indistinguishable from "no sessions
 * exist", and callers that DESTROY user data on that answer must not act on
 * it. Starts reconciliation if nothing has yet (tests, harness routes).
 */
export function whenAgentTasksReconciled(): Promise<boolean> {
  ensureAgentTasksReconciled();
  return reconcileSettled ?? Promise.resolve(true);
}

/** Test-only: allow the once-per-session guard to re-arm. */
export function resetAgentTasksReconciledForTest(): void {
  reconcileStarted = false;
  reconcileSettled = null;
}

export const agentTurnsCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-turns",
    getKey: (turn: AgentTurn) => turn.turnId,
  }),
);

export const agentEntriesCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-entries",
    getKey: (entry: AgentEntry) => entry.id,
  }),
);

export const agentPermissionRequestsCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-permission-requests",
    getKey: (request: AgentPermissionRequestRow) => request.id,
  }),
);

/**
 * Collection-maintained taskId indexes. The service's maintenance passes
 * (replay purge, lingering-tool resolution, task-row purge) would otherwise
 * full-scan entries/turns — collections that now grow with replayed history
 * across every task in the workspace. `eq(taskId)` live queries pick these
 * up through the query planner for free.
 */
const entriesByTask = agentEntriesCollection.createIndex(
  (entry) => entry.taskId,
  { indexType: BasicIndex },
);
const turnsByTask = agentTurnsCollection.createIndex((turn) => turn.taskId, {
  indexType: BasicIndex,
});

export function agentEntriesForTask(taskId: string): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const key of entriesByTask.equalityLookup(taskId)) {
    const entry = agentEntriesCollection.get(String(key));
    if (entry) entries.push(entry);
  }
  return entries;
}

export function agentTurnsForTask(taskId: string): AgentTurn[] {
  const turns: AgentTurn[] = [];
  for (const key of turnsByTask.equalityLookup(taskId)) {
    const turn = agentTurnsCollection.get(String(key));
    if (turn) turns.push(turn);
  }
  return turns;
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

/** The live target: entries land in the collections as they stream. */
export const liveEntryWriter: AgentEntryWriter = {
  insert: (row) =>
    agentEntriesCollection.insert({ ...row, createdAt: Date.now() }),
  update: (id, mutate) => agentEntriesCollection.update(id, mutate),
  delete: (id) => agentEntriesCollection.delete(id),
  entriesForTask: agentEntriesForTask,
};

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
    for (const entry of agentEntriesForTask(taskId)) {
      if (!keepTurnIds.has(entry.turnId)) {
        agentEntriesCollection.delete(entry.id);
      }
    }
    for (const turn of agentTurnsForTask(taskId)) {
      if (!keepTurnIds.has(turn.turnId)) {
        agentTurnsCollection.delete(turn.turnId);
      }
    }
    agentTurnsCollection.insert(replayTurn);
    for (const row of this.rows.values()) {
      agentEntriesCollection.insert(row);
    }
  }
}
