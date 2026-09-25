import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  AuthMethod,
  Client,
  ClientCapabilities,
  ContentBlock,
  InitializeResponse,
  LegacyModelState,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelect,
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

/**
 * Which wire surface a normalized config option came from — decides the
 * method a switch goes out as. Module-private on purpose: above this file
 * every option is just a `SessionConfigSelect`.
 */
type ConfigSource = "config" | "mode" | "model";

type SessionConfigState = {
  options: SessionConfigSelect[];
  sources: Map<string, ConfigSource>;
};

/** The unstable `models` block older adapters still attach to session answers. */
type LegacyModels = { models?: LegacyModelState | null };

const EMPTY_CONFIG: SessionConfigState = { options: [], sources: new Map() };

/** Ids of the options synthesized from the legacy mode/model surfaces. */
const LEGACY_MODE_OPTION_ID = "mode";
const LEGACY_MODEL_OPTION_ID = "model";

function isSelectOption(
  option: SessionConfigOption,
): option is SessionConfigSelect {
  return option.type === "select";
}

/** Native `configOptions` as the state: booleans dropped (never advertised). */
function fromConfigOptions(
  configOptions: readonly SessionConfigOption[],
): SessionConfigState {
  const options = configOptions.filter(isSelectOption);
  return {
    options,
    sources: new Map(options.map((option) => [option.id, "config"])),
  };
}

/**
 * Fold whatever a session/new or session/load answer carries into one
 * option list. Native `configOptions` win outright (spec: clients SHOULD
 * ignore `modes` when they are present); otherwise legacy `modes` and the
 * unstable pre-1.x `models` block synthesize a mode and a model option, in
 * that order, so a picker built on this list looks the same either way.
 */
export function normalizeSessionConfig(
  response: Pick<NewSessionResponse, "modes" | "configOptions"> & {
    models?: LegacyModelState | null;
  },
): SessionConfigState {
  if (response.configOptions && response.configOptions.length > 0) {
    return fromConfigOptions(response.configOptions);
  }
  const state: SessionConfigState = { options: [], sources: new Map() };
  if (response.modes) {
    state.options.push({
      id: LEGACY_MODE_OPTION_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: response.modes.currentModeId,
      options: response.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    });
    state.sources.set(LEGACY_MODE_OPTION_ID, "mode");
  }
  if (response.models) {
    state.options.push({
      id: LEGACY_MODEL_OPTION_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: response.models.currentModelId,
      options: response.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    });
    state.sources.set(LEGACY_MODEL_OPTION_ID, "model");
  }
  return state;
}

/** The same state with one option's current value replaced. */
function withCurrentValue(
  state: SessionConfigState,
  optionId: string,
  value: string,
): SessionConfigState {
  return {
    sources: state.sources,
    options: state.options.map((option) =>
      option.id === optionId ? { ...option, currentValue: value } : option,
    ),
  };
}

/**
 * The option a `current_mode_update` addresses: the legacy-sourced mode
 * option, else the native option in the `mode` category (an agent may send
 * both surfaces). Undefined when the session advertises no mode at all.
 */
function modeOptionId(state: SessionConfigState): string | undefined {
  for (const [id, source] of state.sources) if (source === "mode") return id;
  return state.options.find((option) => option.category === "mode")?.id;
}

export type AcpClientDeps = {
  /** The task this connection belongs to — one connection per task. */
  taskId: string;
  transport: AgentTransport;
  permissionBroker: PermissionRequester;
  /** AgentTask sink for session/update notifications */
  onSessionUpdate: (notification: SessionNotification) => void;
  /**
   * The session's switchable settings changed — after session/new and
   * session/load answer, after a switch, and on the agent's own
   * config/mode notifications (folded here, so the sink never re-derives
   * them from the raw update). Always the full current list.
   */
  onSessionConfigChange?: (
    sessionId: string,
    options: SessionConfigSelect[],
  ) => void;
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
  /** Per-session normalized config options + where each one came from. */
  private readonly sessionConfigs = new Map<string, SessionConfigState>();

  constructor(private readonly deps: AcpClientDeps) {}

  /** Open the connection: initialize + capability negotiation. */
  async connect(): Promise<InitializeResponse> {
    const { writable, readable } = transportToStreams(this.deps.transport);
    // ndJsonStream(output, input): output is where we send encoded messages,
    // input is where we receive them. Our transport's writable decodes lines
    // into transport.send(); its readable enqueues incoming lines.
    const stream = ndJsonStream(writable, readable);
    // The ClientSideConnection is itself the Agent-side handle we call. The
    // SDK marks this constructor deprecated in favour of its `client()`
    // builder; the builder only adds connection-scoped context we don't use,
    // so the direct form stays until a spec bump forces the switch.
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
    /** Harness-specific extension fields (e.g. devin's
     *  `additionalDirectories`), spread into the request verbatim. */
    extensionParams: Record<string, unknown> = {},
  ): Promise<NewSessionResponse> {
    const response = await this.requireConnection().newSession({
      cwd,
      mcpServers,
      ...extensionParams,
    });
    this.storeSessionConfig(
      response.sessionId,
      normalizeSessionConfig(response as NewSessionResponse & LegacyModels),
    );
    return response;
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
    /** Same extension spread as newSession — a session revived without the
     *  fields it was created with would drop what they granted. */
    extensionParams: Record<string, unknown> = {},
  ): Promise<LoadSessionResponse> {
    const response = await this.requireConnection().loadSession({
      sessionId,
      cwd,
      mcpServers,
      ...extensionParams,
    });
    this.storeSessionConfig(
      sessionId,
      normalizeSessionConfig(response as LoadSessionResponse & LegacyModels),
    );
    return response;
  }

  /** The session's switchable settings as last reported (empty = none). */
  sessionConfigOptions(sessionId: string): SessionConfigSelect[] {
    return this.sessionConfigs.get(sessionId)?.options ?? [];
  }

  /**
   * Switch one of the session's settings. Dispatches on where the option
   * came from: native options go out as `session/set_config_option` and the
   * agent's answer becomes the new list; a legacy mode as
   * `session/set_mode`; the unstable model surface as `session/set_model`.
   * The legacy methods answer nothing, so the value is applied locally (the
   * agent may echo a `current_mode_update` too, which folds to the same
   * state). Rejects on a JSON-RPC error with the list unchanged. Resolves
   * with the list after the switch.
   */
  async setSessionConfigOption(
    sessionId: string,
    optionId: string,
    value: string,
  ): Promise<SessionConfigSelect[]> {
    const source = this.sessionConfigs.get(sessionId)?.sources.get(optionId);
    if (!source) {
      throw new Error(`session has no config option "${optionId}"`);
    }
    const connection = this.requireConnection();
    // The legacy methods answer nothing, so the value is applied onto the
    // list as it is AFTER the round trip — a concurrent switch of another
    // option (or a folded notification) landed meanwhile and must survive.
    const applyLocally = () =>
      this.storeSessionConfig(
        sessionId,
        withCurrentValue(
          this.sessionConfigs.get(sessionId) ?? EMPTY_CONFIG,
          optionId,
          value,
        ),
      );
    switch (source) {
      case "config": {
        const response = await connection.setSessionConfigOption({
          sessionId,
          configId: optionId,
          value,
        });
        this.storeSessionConfig(
          sessionId,
          fromConfigOptions(response.configOptions),
        );
        break;
      }
      case "mode":
        await connection.setSessionMode({ sessionId, modeId: value });
        applyLocally();
        break;
      case "model":
        // Pre-1.x unstable method: not in the SDK's typed surface, so it
        // goes out as an extension call with the params it always took.
        await connection.extMethod("session/set_model", {
          sessionId,
          modelId: value,
        });
        applyLocally();
        break;
    }
    return this.sessionConfigOptions(sessionId);
  }

  private storeSessionConfig(
    sessionId: string,
    state: SessionConfigState,
  ): void {
    this.sessionConfigs.set(sessionId, state);
    this.deps.onSessionConfigChange?.(sessionId, state.options);
  }

  /**
   * Keep the stored options current from the agent's own notifications:
   * `config_option_update` carries the whole new list; `current_mode_update`
   * moves the mode option's value (a value outside the advertised choices is
   * kept as-is — the picker shows the raw id rather than nothing).
   */
  private foldSessionConfigUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;
    if (update.sessionUpdate === "config_option_update") {
      this.storeSessionConfig(
        sessionId,
        fromConfigOptions(update.configOptions),
      );
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      const state = this.sessionConfigs.get(sessionId);
      const optionId = state && modeOptionId(state);
      if (!state || !optionId) return;
      this.storeSessionConfig(
        sessionId,
        withCurrentValue(state, optionId, update.currentModeId),
      );
    }
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
   * close re-syncs only the transcript, not the model's context). Rejects on
   * a JSON-RPC error (an adapter without the method answers -32601) and on
   * transport close — callers treat failure as "close unsupported" and fall
   * back to a plain reload.
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.requireConnection().closeSession({ sessionId });
    this.sessionConfigs.delete(sessionId);
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
    this.foldSessionConfigUpdate(notification);
    this.deps.onSessionUpdate(notification);
  }
}
