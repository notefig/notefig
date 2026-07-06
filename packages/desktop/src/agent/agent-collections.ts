/**
 * Local-only TanStack DB collections for agent session state. These are
 * ephemeral (per app run) — session history that must survive restarts goes
 * through ACP session/load, not through here. UI consumes them with
 * useLiveQuery, the same idiom as the file collections.
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";

export type AgentTurnStatus = "running" | "completed" | "cancelled" | "error";

export type AgentTurn = {
  turnId: string;
  sessionId: string;
  workspacePath: string;
  status: AgentTurnStatus;
  /** ACP stop reason once the turn ends */
  stopReason?: string;
  startedAt: number;
};

export type AgentEventKind =
  | "message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "usage";

export type AgentEvent = {
  id: string;
  turnId: string;
  kind: AgentEventKind;
  /** Raw session/update payload; message chunks are coalesced per turn */
  payload: unknown;
  receivedAt: number;
};

export type AgentPermissionRequestRow = {
  id: string;
  sessionId: string;
  title: string;
  /** ACP PermissionOption[] rendered verbatim */
  options: unknown[];
  status: "pending" | "granted" | "denied" | "cancelled";
};

export const agentTurnsCollection = createCollection(
  localOnlyCollectionOptions({
    id: "agent-turns",
    getKey: (turn: AgentTurn) => turn.turnId,
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
