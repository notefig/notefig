/**
 * The single isolation point for the Agent Client Protocol.
 *
 * Every Metrists module that touches ACP imports its protocol types from
 * here, never from `@agentclientprotocol/sdk` directly. The spec is young;
 * when it moves, this file is the only place that changes.
 *
 * Type-only re-exports: this module emits no runtime require of the ACP
 * library (which is ESM), so it stays safe to consume from the CommonJS
 * CLI build.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export type {
  ClientSideConnection,
  Client,
  Agent,
  InitializeRequest,
  InitializeResponse,
  ClientCapabilities,
  AuthenticateRequest,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  ContentBlock,
  SessionNotification,
  ToolCallUpdate,
  ToolCallContent,
  ToolKind,
  ToolCallStatus,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CancelNotification,
  AuthMethod,
  Stream,
  McpServer,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
  SessionModeState,
} from "@agentclientprotocol/sdk";

/**
 * The MCP server name the desktop app advertises in `session/new.mcpServers`
 * and the prefix adapters mint tool names under (`mcp__notefig__<tool>`).
 * Single-sourced here, next to the `McpServer` type, so the transport that
 * builds the entry and the server that answers `initialize` can't drift —
 * without dragging the tool/blob registries into the transport's module
 * graph (which importing it from mcp-server.ts would).
 */
export const MCP_SERVER_NAME = "notefig";

/** Why the agent stopped a turn (PromptResponse["stopReason"]). */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** Result of a prompt handle's `completed` promise. */
export type TurnOutcome =
  | { status: "completed"; stopReason?: string }
  | { status: "error"; error: string }
  | { status: "cancelled" };

/**
 * A switchable per-session setting as the app sees it: the spec's select
 * config option (mode, model, effort, …). Legacy `modes` (and the unstable
 * `models` some adapters still send) are folded into this shape at the ACP
 * client boundary, so nothing above `acp-client.ts` knows which wire
 * surface a session actually speaks. Boolean options are dropped there:
 * the client never advertises `session.configOptions.boolean`.
 */
export type SessionConfigSelect = Extract<SessionConfigOption, { type: "select" }>;

/**
 * The unstable `models` block of ACP 0.x `session/new` responses — dropped
 * from the 1.x typings but still emitted by older adapters. Read via a
 * loose cast at the client boundary and folded into a `model` config
 * option; never re-exported above it.
 */
export type LegacyModelState = {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
};
