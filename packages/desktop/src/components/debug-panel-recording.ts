/**
 * The debug panel's "Recording" export: a session's transcript re-shaped
 * into the script the mock harness plays back (`replay` scenario,
 * src/agent/mock-harness.ts). Colocated with the panel because the panel
 * is the only producer; the mock harness imports the types only.
 *
 * The record IS the transcript collections — tasks, turns, entries,
 * permission requests — the same rows the debug panel's session report
 * reads. `buildSessionRecording` is a pure re-format of those rows into
 * per-turn agent→client events, so nothing in the live agent lifecycle
 * exists to serve this: no taps, no wrappers, no extra state. The debug
 * panel's Session tab exposes it as "Recording" (JSON to the clipboard).
 *
 * WHAT A DERIVED RECORDING CARRIES vs the wire: one chunk per assistant /
 * thought entry (not the token-level chunks), one `tool_call` event holding
 * each call's final state (not the pending → in_progress → completed
 * updates), the turn's final plan (the app keeps one plan per turn), and
 * each permission request as a `session/request_permission` event with its
 * options and the recorded outcome. Enough to reproduce every rendered
 * state; a hand-authored fixture can still spell out finer-grained frames
 * (tests/agent/fixtures/README.md).
 */
import type {
  AgentEntry,
  AgentPermissionRequestRow,
  AgentTaskRow,
  AgentTurn,
} from "@notefig/shared/agent";
import { sortEntriesChronologically } from "@notefig/shared/agent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// ─── The format ─────────────────────────────────────────────────────────────

export const AGENT_RECORDING_FORMAT = "notefig-agent-recording" as const;
export const AGENT_RECORDING_VERSION = 1 as const;

/** One agent→client event inside a turn. `at` is ms since the turn's
 *  `session/prompt` was sent (monotonic within the turn; synthetic in a
 *  derived recording — entries carry no wire timing). */
export type RecordedEvent =
  | {
      kind: "update";
      at: number;
      /** A `session/update` notification's `update` payload. */
      update: Json;
    }
  | {
      kind: "request";
      at: number;
      /** An agent→client JSON-RPC request (`session/request_permission`,
       *  `fs/read_text_file`, `fs/write_text_file`, …). */
      method: string;
      params: Json;
      /** What the app answered (the JSON-RPC `result`), when known. */
      response?: Json;
      error?: { code: number; message: string };
    }
  | {
      kind: "mcp";
      at: number;
      /** An MCP request the harness made against the app's tool server
       *  (`tools/call`, `resources/read`). Hand-authored fixtures only —
       *  the transcript records app-tool calls as `tool_call` entries. */
      method: string;
      params: Json;
      result?: Json;
      error?: { code: number; message: string };
    };

export type RecordedTurn = {
  /** The `session/prompt` content blocks (a derived recording has the
   *  user entry's text; a hand-authored one may add resource_link parts). */
  prompt: Json[];
  /** ms since the recording started. */
  startedAt: number;
  events: RecordedEvent[];
  /** The `session/prompt` response, once it arrived. */
  stopReason?: string;
  error?: { code: number; message: string };
  /** ms since the recording started; unset while the turn is still open. */
  endedAt?: number;
};

export type AgentRecording = {
  format: typeof AGENT_RECORDING_FORMAT;
  version: typeof AGENT_RECORDING_VERSION;
  recordedAt: string;
  harnessId: string;
  taskId: string;
  /** The workspace the recording was made in — replays substitute the live
   *  workspace path for it wherever it appears in events. */
  workspacePath: string;
  /** The harness's ACP session id. */
  sessionId?: string;
  /** Events that belong to no turn. Kept for inspection; the replay
   *  scenario does not play them. */
  outOfTurn: RecordedEvent[];
  turns: RecordedTurn[];
};

/** Structural check for a parsed JSON recording (fixtures, clipboard). */
export function isAgentRecording(value: unknown): value is AgentRecording {
  const r = value as Partial<AgentRecording> | null;
  return (
    !!r &&
    r.format === AGENT_RECORDING_FORMAT &&
    r.version === AGENT_RECORDING_VERSION &&
    Array.isArray(r.turns) &&
    typeof r.taskId === "string"
  );
}

// ─── Deriving one from the transcript ───────────────────────────────────────

/** Synthetic spacing between derived events (ms) — gives a paced replay
 *  (`speed: 1`) a visible stream without inventing real timings. */
const DERIVED_EVENT_GAP_MS = 100;

/** A transcript entry as the update the harness would have sent for it. */
function entryUpdate(entry: AgentEntry): Json | null {
  switch (entry.type) {
    case "assistant":
      return textChunk("agent_message_chunk", entry.text);
    case "thought":
      return textChunk("agent_thought_chunk", entry.text);
    case "tool_call":
      // The stored call is the merge of every update it received and keeps
      // the last one's `sessionUpdate` — replay it as the opening tool_call.
      return entry.toolCall
        ? { ...entry.toolCall, sessionUpdate: "tool_call" }
        : null;
    case "plan": {
      const plan = entry.plan as { entries?: unknown } | undefined;
      return plan?.entries
        ? { sessionUpdate: "plan", entries: plan.entries }
        : null;
    }
    case "unknown":
      return entry.raw ?? null;
    case "user":
      return null; // the prompt, not an event
  }
}

function textChunk(kind: string, text: string | undefined): Json | null {
  return text
    ? { sessionUpdate: kind, content: { type: "text", text } }
    : null;
}

/**
 * A permission row as the request the harness made, with what the app
 * answered. The row keeps only whether it was settled (the broker marks
 * any explicit choice "granted" and never stores the optionId), so the
 * derived reply is `selected` without an option, or `cancelled`.
 */
function permissionRequestEvent(
  row: AgentPermissionRequestRow,
  at: number,
): RecordedEvent {
  return {
    kind: "request",
    at,
    method: "session/request_permission",
    params: {
      sessionId: row.sessionId,
      toolCall: { toolCallId: row.id, title: row.title },
      options: row.options,
    },
    response:
      row.status === "pending"
        ? undefined
        : row.status === "cancelled"
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected" } },
  };
}

function turnTermination(
  turn: AgentTurn,
): Pick<RecordedTurn, "stopReason" | "error"> {
  if (turn.status === "error") {
    return { error: { code: -32000, message: turn.error ?? "turn failed" } };
  }
  if (turn.status === "cancelled") return { stopReason: "cancelled" };
  return { stopReason: turn.stopReason ?? "end_turn" };
}

/** One turn's events: its permission requests (they interrupt the turn,
 *  so they come first), then each entry as the update behind it. */
function turnEvents(
  entries: AgentEntry[],
  permissions: AgentPermissionRequestRow[],
): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  let at = 0;
  for (const row of permissions) {
    events.push(permissionRequestEvent(row, (at += DERIVED_EVENT_GAP_MS)));
  }
  for (const entry of entries) {
    const update = entryUpdate(entry);
    if (update) events.push({ kind: "update", at: (at += DERIVED_EVENT_GAP_MS), update });
  }
  return events;
}

/**
 * Re-shape one task's transcript rows into a recording. Pure: takes the
 * rows the caller already holds (the debug panel's live queries), returns
 * a fresh object. Permission rows carry no turn id, so they're attributed
 * to the LAST turn — the one a harness was running when it asked.
 */
export function buildSessionRecording(input: {
  task: AgentTaskRow;
  turns: AgentTurn[];
  entries: AgentEntry[];
  permissionRequests: AgentPermissionRequestRow[];
}): AgentRecording {
  const turns = [...input.turns].sort((a, b) =>
    a.turnId < b.turnId ? -1 : 1,
  );
  const entries = sortEntriesChronologically(input.entries);
  const permissions = [...input.permissionRequests].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const base = turns[0]?.startedAt ?? input.task.createdAt;

  const recordedTurns = turns.map((turn, index): RecordedTurn => {
    const own = entries.filter((e) => e.turnId === turn.turnId);
    const events = turnEvents(
      own,
      index === turns.length - 1 ? permissions : [],
    );
    const startedAt = Math.max(0, turn.startedAt - base);
    const last = events[events.length - 1];
    return {
      prompt: own
        .filter((e) => e.type === "user")
        .map((e) => ({ type: "text", text: e.text ?? "" })),
      startedAt,
      events,
      ...turnTermination(turn),
      endedAt: startedAt + (last?.at ?? 0) + DERIVED_EVENT_GAP_MS,
    };
  });

  // Turnless entries (adapter stragglers after a cancel, MET-104).
  const turnIds = new Set(turns.map((t) => t.turnId));
  const outOfTurn = turnEvents(
    entries.filter((e) => !turnIds.has(e.turnId)),
    [],
  );

  return {
    format: AGENT_RECORDING_FORMAT,
    version: AGENT_RECORDING_VERSION,
    recordedAt: new Date().toISOString(),
    harnessId: input.task.harnessId,
    taskId: input.task.taskId,
    workspacePath: input.task.workspacePath,
    sessionId: input.task.sessionId,
    outOfTurn,
    turns: recordedTurns,
  };
}
