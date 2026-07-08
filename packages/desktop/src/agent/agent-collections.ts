/**
 * Local-only TanStack DB collections for agent task state. Every row is
 * keyed to a task — parallelism is structural, not bolted on. These are
 * ephemeral (per app run) — durable history arrives in Phase 4 via ACP
 * session/load + KV transcript fallback. UI consumes them with
 * useLiveQuery, the same idiom as the file collections.
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";

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

/**
 * The addressable transcript unit — what deep links, revert, and Phase 4
 * persistence key on. ACP streams anonymous chunks, so message ids are
 * minted client-side (newMessageId): one user message when we send the
 * prompt, one assistant message when its first update arrives.
 */
export type AgentMessageRow = {
  /** msg_ (ascending: lexicographic sort = chronological) */
  messageId: string;
  taskId: string;
  turnId: string;
  role: "user" | "assistant";
  createdAt: number;
};

export type AgentEventKind =
  | "message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "usage";

export type AgentEvent = {
  /** evt_ (ascending) */
  id: string;
  /** The message this event belongs to (chunks → the assistant message) */
  messageId: string;
  turnId: string;
  taskId: string;
  kind: AgentEventKind;
  /** Raw session/update payload; message chunks are coalesced per message */
  payload: unknown;
  receivedAt: number;
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

export const agentMessagesCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-messages",
    getKey: (message: AgentMessageRow) => message.messageId,
  }),
);

export const agentEventsCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-events",
    getKey: (event: AgentEvent) => event.id,
  }),
);

export const agentPermissionRequestsCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-permission-requests",
    getKey: (request: AgentPermissionRequestRow) => request.id,
  }),
);
