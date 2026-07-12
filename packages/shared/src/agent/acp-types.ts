/**
 * The single isolation point for the Agent Client Protocol.
 *
 * Every Metrists module that touches ACP imports its protocol types from
 * here, never from `@zed-industries/agent-client-protocol` directly. The
 * spec is young; when it moves, this file is the only place that changes.
 *
 * Type-only re-exports: this module emits no runtime require of the ACP
 * library (which is ESM), so it stays safe to consume from the CommonJS
 * CLI build.
 */
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
} from "@zed-industries/agent-client-protocol";

/**
 * The MCP server name the desktop app advertises in `session/new.mcpServers`
 * and the prefix adapters mint tool names under (`mcp__metrists__<tool>`).
 * Single-sourced here, next to the `McpServer` type, so the transport that
 * builds the entry and the server that answers `initialize` can't drift —
 * without dragging the tool/blob registries into the transport's module
 * graph (which importing it from mcp-server.ts would).
 */
export const MCP_SERVER_NAME = "metrists";

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
