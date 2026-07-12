import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import type {
  AuthMethod,
  Client,
  ClientCapabilities,
  ContentBlock,
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@metrists/shared/agent";
import { transportToStreams } from "./agent-transport.interface";
import type { AgentTransport } from "./agent-transport.interface";
import type { PermissionBroker } from "./permission-broker";
import { MCP_SERVER_NAME } from "@metrists/shared/agent";
import {
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "@/utils/file-sync";

/**
 * Claude Code (and presumably other adapters) asks for permission before
 * *any* tool call by default, MCP included — separate from, and in addition
 * to, our own `dispatchToolCall`'s `requiresPermission` gate in
 * mcp-server.ts. That's the right default for the adapter's own native
 * fs/bash tools (they touch disk directly, outside our mediation), but
 * redundant for our own MCP tools: they're already consent-gated internally
 * where that matters (e.g. `history_restore`), so a second UI prompt here
 * only adds friction for zero extra safety. Recognize the adapter's
 * `mcp__<server>__<tool>` naming (confirmed on claude-agent-acp,
 * docs/architecture/spikes/v2-mcp-passthrough-spike.md) and auto-approve.
 */
function isMetristsMcpToolCall(request: RequestPermissionRequest): boolean {
  return (request.toolCall.title ?? "").startsWith(`mcp__${MCP_SERVER_NAME}__`);
}

/** ACP protocol version we speak (pinned; a spec bump changes acp-types). */
const PROTOCOL_VERSION = 1;

/**
 * Capabilities are a function of where the agent process runs relative to
 * the files. Desktop: the app and the files share a machine, so we mediate
 * reads/writes through the workspace file-sync helpers. Remote (web): the
 * files live with the harness, not the browser — advertise fs:false and the
 * harness uses its native file tools; the app adopts changes via the watch
 * channel. This asymmetry is the whole reason the CLI worker can stay a
 * protocol-ignorant byte pump.
 */
export function capabilitiesForLocus(
  locus: AgentTransport["locus"],
): ClientCapabilities {
  return locus === "local"
    ? { fs: { readTextFile: true, writeTextFile: true } }
    : { fs: { readTextFile: false, writeTextFile: false } };
}

export type AcpClientDeps = {
  /** The task this connection belongs to — one connection per task. */
  taskId: string;
  transport: AgentTransport;
  permissionBroker: PermissionBroker;
  /** AgentTask sink for session/update notifications */
  onSessionUpdate: (notification: SessionNotification) => void;
};

/**
 * The Metrists side of one task's ACP connection: implements the
 * client-side methods the protocol requires of us and hands everything
 * else to the owning AgentTask. Wraps the official library's
 * ClientSideConnection over transportToStreams(transport), so it is
 * transport-agnostic by construction. The app is the sole ACP client on
 * both platforms; Rust/CLI-worker layers never parse the protocol.
 */
export class MetristsAcpClient implements Client {
  private connection: ClientSideConnection | null = null;
  /** From the initialize response — drives auth affordance and capability gating. */
  private authMethods: AuthMethod[] = [];
  private agentCapabilities: InitializeResponse["agentCapabilities"] = undefined;

  constructor(private readonly deps: AcpClientDeps) {}

  /** Open the connection: initialize + capability negotiation. */
  async connect(): Promise<InitializeResponse> {
    const { writable, readable } = transportToStreams(this.deps.transport);
    // ndJsonStream(output, input): output is where we send encoded messages,
    // input is where we receive them. Our transport's writable decodes lines
    // into transport.send(); its readable enqueues incoming lines.
    const stream = ndJsonStream(writable, readable);
    // The ClientSideConnection is itself the Agent-side handle we call.
    this.connection = new ClientSideConnection(() => this, stream);

    const response = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: capabilitiesForLocus(this.deps.transport.locus),
    });
    this.authMethods = response.authMethods ?? [];
    this.agentCapabilities = response.agentCapabilities;
    return response;
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP connection not established; call connect() first");
    }
    return this.connection;
  }

  // ===== Agent-side calls (thin wrappers the AgentTask uses) =====

  async newSession(
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<NewSessionResponse> {
    return this.requireConnection().newSession({ cwd, mcpServers });
  }

  async prompt(sessionId: string, blocks: ContentBlock[]): Promise<PromptResponse> {
    return this.requireConnection().prompt({ sessionId, prompt: blocks });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requireConnection().cancel({ sessionId });
  }

  /**
   * Human-readable "how to authenticate" hint from the adapter, if any.
   * claude-code-acp advertises `{ id: "claude-login", description: "Run
   * `claude /login` in the terminal" }` (see the auth spike); we prefer this
   * over a hardcoded HarnessDefinition.authHint.
   */
  get authHint(): string | undefined {
    return this.authMethods[0]?.description ?? undefined;
  }

  /** Whether the adapter advertised `promptCapabilities.embeddedContext` (drives PromptComposer's degrade path). */
  get embeddedContextCapability(): boolean {
    return this.agentCapabilities?.promptCapabilities?.embeddedContext ?? false;
  }

  // ===== ACP client-side methods (called by the agent) =====
  // fs/* are only reachable on desktop (remote advertises fs:false; a
  // misbehaving agent calling them anyway gets a JSON-RPC error).

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (isMetristsMcpToolCall(request)) {
      const grant =
        request.options.find((o) => o.kind === "allow_always") ??
        request.options.find((o) => o.kind === "allow_once");
      if (grant) {
        return { outcome: { outcome: "selected", optionId: grant.optionId } };
      }
    }
    return this.deps.permissionBroker.request(request);
  }

  async readTextFile(
    request: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const content = await readWorkspaceTextFile(request.path, {
      line: request.line ?? undefined,
      limit: request.limit ?? undefined,
    });
    return { content };
  }

  async writeTextFile(
    request: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await writeWorkspaceTextFile(request.path, request.content);
    return {};
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.deps.onSessionUpdate(notification);
  }
}
