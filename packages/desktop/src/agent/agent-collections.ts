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
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/query-core";
import type { AuthMethod, ToolCallUpdate } from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { getRegisteredTask } from "./task-registry";
import {
  AGENT_TASKS_NAMESPACE,
  bootAgentTaskRow,
  parsePersistedAgentTasks,
  persistableAgentTaskRow,
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
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "error";

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
  createdAt: number;
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
 * Storage-backed (MET-54): a query collection over the KV seam — the same
 * unified-storage idiom as the file collections over fs. Every mutation
 * writes through; the boot read maps stored rows back to live ones. The one
 * coherence rule lives in the queryFn: a task with a live runtime passes
 * through as stored (write-through keeps disk current, so a refetch can
 * never clobber runtime state); a task without one loads as "restored"
 * (revivable via session/load) or not at all (no session — nothing to
 * revive). Everything else about persistence falls out of this shape: no
 * mirror, no restore step, no dispose bookkeeping.
 */
// Own client, not the shared one from utils/collections: importing that here
// closes a module cycle (utils/collections ↔ file-sync ↔ editor modules)
// that leaves queryClient undefined at eval time — and nothing else needs to
// share this collection's cache.
const agentTasksQueryClient = new QueryClient();

export const agentTasksCollection = createCollection(
  queryCollectionOptions<AgentTaskRow, string>({
    queryKey: ["agent-tasks"],
    queryClient: agentTasksQueryClient,
    queryFn: async () => {
      const raw = await platformAdapter.getAllKv<unknown>(AGENT_TASKS_NAMESPACE);
      const rows: AgentTaskRow[] = [];
      for (const stored of parsePersistedAgentTasks(raw)) {
        const task = getRegisteredTask(stored.taskId);
        if (task) {
          // Write-through keeps disk current for live tasks, so the stored
          // row IS the collection row — except status, which the schema only
          // validates as a string (kv.json is hand-editable): a foreign value
          // falls back to the runtime's own status instead of entering the
          // union unchecked.
          const row = stored as AgentTaskRow;
          rows.push(
            isAgentTaskStatus(stored.status)
              ? row
              : { ...row, status: task.currentStatus },
          );
          continue;
        }
        const boot = bootAgentTaskRow(stored);
        if (boot) rows.push(boot);
      }
      return rows;
    },
    getKey: (task) => task.taskId,
    // Persistence is best-effort: a throwing handler would roll back the
    // optimistic mutation — the row's status would visibly revert while the
    // runtime keeps going. Memory is the source of truth; a failed KV write
    // leaves disk stale until the next write-through repairs it.
    onInsert: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        try {
          await platformAdapter.setKv(
            AGENT_TASKS_NAMESPACE,
            m.modified.taskId,
            persistableAgentTaskRow(m.modified),
          );
        } catch (error) {
          console.warn("[agent-tasks] persist failed", m.modified.taskId, error);
        }
      }
    },
    onUpdate: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        try {
          await platformAdapter.setKv(
            AGENT_TASKS_NAMESPACE,
            m.modified.taskId,
            persistableAgentTaskRow(m.modified),
          );
        } catch (error) {
          console.warn("[agent-tasks] persist failed", m.modified.taskId, error);
        }
      }
    },
    onDelete: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        try {
          await platformAdapter.deleteKv(AGENT_TASKS_NAMESPACE, String(m.key));
        } catch (error) {
          console.warn("[agent-tasks] delete failed", String(m.key), error);
        }
      }
    },
  }),
);

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
