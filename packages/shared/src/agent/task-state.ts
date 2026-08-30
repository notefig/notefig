/**
 * The shape of a task's live agent state: the task row, its turns, its
 * transcript entries, and pending permission requests.
 *
 * These live in shared rather than beside the TanStack collections that
 * store them because they are read across a package boundary: @notefig/widgets
 * derives the prompt widget's whole state machine from turns and entries, and
 * neither package owns the other. The collections in the desktop app remain
 * the only place these rows are written.
 */
import type { AuthMethod, ToolCallUpdate } from "./acp-types";

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
 * A turn's transcript in render order.
 *
 * Entry ids are minted ascending (see AgentEntry), so lexicographic sort IS
 * chronological order — `createdAt` is absent on session/load replay and must
 * never be used for this. The rule lives here, beside the type that
 * establishes it, because both the chat transcript and the prompt widget
 * depend on it and neither owns the other.
 */
export function sortEntriesChronologically(
  entries: AgentEntry[],
): AgentEntry[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
}
