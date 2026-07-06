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
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  CancelNotification,
} from "@zed-industries/agent-client-protocol";

/** Why the agent stopped a turn (PromptResponse["stopReason"]). */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";
