import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import type {
  AuthMethod,
  Client,
  ClientCapabilities,
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
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
} from "@notefig/shared/agent";
import { transportToStreams } from "./agent-transport.interface";
import type { AgentTransport } from "./agent-transport.interface";
import type { PermissionRequester } from "./permission-requester";

/**
 * ACP protocol versions we speak (a spec bump changes acp-types, so a new
 * entry means new types were verified too). ACP negotiation is a downgrade
 * handshake: we request our latest; an older agent answers with its own,
 * and `connect()` rejects if the negotiated version isn't in this list.
 * Version seam: an ACP v2 would select a client-implementation variant on
 * the negotiated version right after `initialize` resolves.
 */
export const SUPPORTED_ACP_PROTOCOL_VERSIONS: readonly number[] = [1];

const PROTOCOL_VERSION = Math.max(...SUPPORTED_ACP_PROTOCOL_VERSIONS);

/** Ids for raw requests sent outside the library (closeSession) — string
 *  ids, so they can never collide with the library's numeric counter. */
let rawRequestCounter = 0;

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

/**
 * Workspace fs surface the ACP client-side `fs/*` methods delegate to.
 * Desktop injects its file-sync helpers (which adopt writes into live
 * editors); the remote locus advertises fs:false and never calls these.
 */
export type AcpFileSystem = {
  readTextFile(
    path: string,
    options?: { line?: number; limit?: number },
  ): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
};

export type AcpClientDeps = {
  /** The task this connection belongs to — one connection per task. */
  taskId: string;
  transport: AgentTransport;
  permissionBroker: PermissionRequester;
  /** AgentTask sink for session/update notifications */
  onSessionUpdate: (notification: SessionNotification) => void;
  fs: AcpFileSystem;
  /** Fired just before connect() rejects on an unsupported negotiated
   *  version — observability hook (desktop wires telemetry). */
  onUnsupportedProtocolVersion?: (negotiated: number) => void;
};

/**
 * The Metrists side of one task's ACP connection: implements the
 * client-side methods the protocol requires of us and hands everything
 * else to the owning AgentTask. Wraps the official library's
 * ClientSideConnection over transportToStreams(transport), so it is
 * transport-agnostic by construction. The app is the sole ACP client on
 * both platforms; Rust/CLI-worker layers never parse the protocol.
 */
export class NotefigAcpClient implements Client {
  private connection: ClientSideConnection | null = null;
  /** From the initialize response — drives auth affordance and capability gating. */
  private authMethods: AuthMethod[] = [];
  private agentCapabilities: InitializeResponse["agentCapabilities"] =
    undefined;

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
    if (!SUPPORTED_ACP_PROTOCOL_VERSIONS.includes(response.protocolVersion)) {
      this.deps.onUnsupportedProtocolVersion?.(response.protocolVersion);
      // Propagates through agent-service's withStartupTimeout startup-failure
      // path — the task surfaces this message instead of hanging on a
      // connection whose frames we might misread.
      throw new Error(
        `agent negotiated unsupported ACP protocol version ${response.protocolVersion} (supported: ${SUPPORTED_ACP_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
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

  async newSession(
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<NewSessionResponse> {
    return this.requireConnection().newSession({ cwd, mcpServers });
  }

  /**
   * ACP `session/load`: resume a harness-stored session in a fresh process.
   * History replays as ordinary session/update notifications before this
   * resolves (verified on both adapters, 2026-07-15 MET-54 spike — see the
   * capability matrix's loadSession row); a bogus/evicted id rejects.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<LoadSessionResponse> {
    return this.requireConnection().loadSession({ sessionId, cwd, mcpServers });
  }

  async prompt(
    sessionId: string,
    blocks: ContentBlock[],
  ): Promise<PromptResponse> {
    return this.requireConnection().prompt({ sessionId, prompt: blocks });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requireConnection().cancel({ sessionId });
  }

  /**
   * ACP `session/close`: tear down the agent's in-memory session without
   * killing the process — a following `session/load` then rebuilds it from
   * the harness's persisted store, which is the full re-sync primitive
   * (docs/architecture/acp-two-way-spike.md §4.5; a repeat load without the
   * close re-syncs only the transcript, not the model's context).
   *
   * Current adapters route the method, but the pinned @zed-industries client
   * doesn't surface it (its extMethod prefixes `_`), so this rides the
   * transport as a raw JSON-RPC request. A string id can't collide with the
   * library's own numeric counter; the library's only reaction to the
   * response is a console note ("unknown request"). Rejects on a JSON-RPC
   * error (an adapter without the method answers -32601) and on transport
   * close — callers treat failure as "close unsupported" and fall back to a
   * plain reload.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.requireConnection(); // same pipe — only meaningful once connected
    const transport = this.deps.transport;
    const id = `notefig-close-${++rawRequestCounter}`;
    await new Promise<void>((resolve, reject) => {
      const unsubscribers: Array<() => void> = [];
      const settle = (finish: () => void) => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        finish();
      };
      unsubscribers.push(
        transport.onLine((line) => {
          let message: { id?: unknown; error?: { message?: unknown } };
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.id !== id) return;
          if (message.error) {
            const reason = message.error.message;
            settle(() =>
              reject(
                new Error(
                  typeof reason === "string" ? reason : "session/close failed",
                ),
              ),
            );
          } else {
            settle(resolve);
          }
        }),
        transport.onClose(() =>
          settle(() => reject(new Error("transport closed"))),
        ),
      );
      transport.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/close",
          params: { sessionId },
        }),
      );
    });
  }

  /**
   * ACP `authenticate` with one of the methods `initialize` advertised.
   * Out-of-band methods (terminal logins — both claude-code and OpenCode
   * today) typically fail here or no-op; the caller treats a rejection as
   * "method is out-of-band, show its description as instructions".
   */
  async authenticate(methodId: string): Promise<void> {
    await this.requireConnection().authenticate({ methodId });
  }

  /**
   * Auth methods from `initialize` — advertised regardless of login state
   * (Phase 1 finding), so this is "what sign-in looks like", never "is the
   * user signed in". Stage 4 surfaces these on the task row on auth failure.
   */
  get availableAuthMethods(): AuthMethod[] {
    return this.authMethods;
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

  // fs/* are only reachable on desktop (remote advertises fs:false; a
  // misbehaving agent calling them anyway gets a JSON-RPC error).

  /**
   * The harness (claude-code, OpenCode, …) asks for permission before *every*
   * tool call it makes — each file edit, each shell command, each MCP call —
   * separate from, and in addition to, our own `dispatchToolCall`
   * `requiresPermission` gate in mcp-server.ts.
   *
   * For the beta we run fully silent: auto-approve every ACP permission
   * request so the agent isn't gated on a UI prompt for every action.
   * Deliberate (a product decision), with these load-bearing caveats:
   *   - The metrists MCP tools that genuinely need consent (`history_restore`)
   *     gate INTERNALLY through `dispatchToolCall` → the broker directly — a
   *     path that never reaches here — so this blanket grant does NOT defeat
   *     them; they still prompt.
   *   - Workspace trust is established once, up front, before any turn runs.
   *   - The pairing secret gates the whole tunnel; nothing untrusted can reach
   *     this method.
   * Prefer `allow_always` so the harness also stops re-asking on its side.
   */
  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const grant =
      request.options.find((o) => o.kind === "allow_always") ??
      request.options.find((o) => o.kind === "allow_once");
    if (grant) {
      return { outcome: { outcome: "selected", optionId: grant.optionId } };
    }
    // No allow option offered (only reject kinds) — hand it to the UI rather
    // than silently cancelling the turn.
    return this.deps.permissionBroker.request(request);
  }

  async readTextFile(
    request: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const content = await this.deps.fs.readTextFile(request.path, {
      line: request.line ?? undefined,
      limit: request.limit ?? undefined,
    });
    return { content };
  }

  async writeTextFile(
    request: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await this.deps.fs.writeTextFile(request.path, request.content);
    return {};
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.deps.onSessionUpdate(notification);
  }
}
