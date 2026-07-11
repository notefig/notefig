/**
 * Local-only TanStack DB collections for agent task state. Every row is
 * keyed to a task — parallelism is structural, not bolted on. These are
 * ephemeral (per app run) — durable history arrives in Phase 4 via ACP
 * session/load + KV transcript fallback. UI consumes them with
 * useLiveQuery, the same idiom as the file collections.
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import type { ToolCallUpdate } from "@metrists/shared/agent";

export type AgentTaskStatus = "starting" | "idle" | "running" | "cancelled" | "error";

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
  createdAt: number;
  /**
   * "How to sign in" hint from the adapter/harness, surfaced on auth errors.
   * On the row (not just the AgentTask instance) so the banner flows through
   * useLiveQuery and can't lag behind an unrelated collection write.
   */
  authHint?: string;
};

export type AgentTurnStatus = "running" | "completed" | "cancelled" | "error";

export type AgentTurn = {
  /** trn_ (ascending) — one per session/prompt round-trip */
  turnId: string;
  taskId: string;
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
  /** user / assistant text runs; unknown: the update's sessionUpdate kind */
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

export const agentTasksCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-tasks",
    getKey: (task: AgentTaskRow) => task.taskId,
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
