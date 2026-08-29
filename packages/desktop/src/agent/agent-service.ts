// Pre-existing tangle: this module reaches the editor/blob component graph
// via mcp-server → widget-context-resource → editor-store, and prompt-blob
// reaches back through the agents facade. Untangling means relocating the
// editor registry to a leaf module (see file-sync's editor-store import
// comment); new cycles elsewhere still gate.
// fallow-ignore-file circular-dependency
import {
  newTaskId,
  newTurnId,
  newEventId,
  BUILT_IN_HARNESSES,
  composePrompt,
  MCP_SERVER_NAME,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
  type ContentBlock,
  type HarnessDefinition,
  type McpServer,
  type PromptContextPart,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
  type TurnOutcome,
} from "@notefig/shared/agent";
import { platformAdapter } from "@/adapters";
import { resolveWorkspacePath } from "@/utils/fs";
import { path as pathutil, workspaceKey } from "@/utils/path";
import { getOrCreateKvCollection } from "@/utils/kv-store";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { PermissionBroker } from "./permission-broker";
import {
  AgentTransportError,
  NotefigAcpClient,
  attachMcpEndpoint,
  createMcpRequestHandler,
  type AgentTransport,
  type McpEndpoint,
} from "@notefig/agent";
import { toolRegistry, getTool } from "./tools";
import { serverInstructions } from "./mcp-instructions";
import { buildWidgetContextPayload } from "./widget-context-resource";
import i18n from "@/utils/intl";
import { captureEvent } from "@/telemetry/telemetry";
import {
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "@/utils/file-sync";
import { checkpointWorkspaceHistory } from "@/utils/history-service";
import { APP_DIR_NAME } from "@/utils/app-dir";
import {
  agentEntriesCollection,
  agentEntriesForTask,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
  agentTurnsForTask,
  liveEntryWriter,
  ReplayStage,
  type AgentEntryWriter,
  type AgentTaskStatus,
  type AgentTurn,
  type AgentTurnStatus,
} from "./agent-collections";
import {
  getRegisteredTask,
  registerTask,
  unregisterTask,
} from "./task-registry";
import {
  MOCK_AGENT_MODE,
  createMockAgentTransport,
  createMockMcpEndpoint,
} from "./mock-harness";
import {
  HARNESS_SETTINGS_NAMESPACE,
  HARNESS_OVERRIDES_KEY,
  HARNESS_CUSTOM_KEY,
} from "./harness-discovery";
// The one `agents` facade (ToolContext.agents). Deferred-use import: this
// module ↔ agents.ts reference each other only inside function bodies, never
// at module-eval time, so evaluation order is a non-issue.
import { agents } from "./agents";

/** KV namespace for agent state (sessionId per task, workspace trust flag). */
const AGENT_KV_NAMESPACE = "agent";

/**
 * Deadline for each step of session establishment (initialize,
 * session/new, session/load incl. history replay). Adapters normally
 * finish in single-digit seconds; an adapter that goes silent (observed
 * in the wild: alive but never answering initialize) must land the task
 * on a visible error instead of an eternal "starting".
 */
const STARTUP_STEP_TIMEOUT_MS = 60_000;

/** Typed so the start() catch classifies timeouts by instanceof, not by
 *  matching its own message string. */
class StartupTimeoutError extends Error {
  constructor(step: string) {
    super(`agent startup timed out (${step})`);
    this.name = "StartupTimeoutError";
  }
}

function withStartupTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StartupTimeoutError(step)),
      STARTUP_STEP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A contiguous streamed run coalescing into one transcript entry. Both
 * assistant text and thoughts stream chunk-by-chunk (OpenCode emits
 * `agent_thought_chunk` per token — 60+ per thought), so per-chunk entries
 * would flood the transcript. A turn has at most one run open at a time;
 * a chunk of the other kind, a tool call, or a plan closes it, keeping
 * entry order chronological.
 */
type StreamRun = {
  kind: "assistant" | "thought";
  entryId: string;
  text: string;
};

/** In-flight turn bookkeeping (chunk coalescing into transcript entries). */
type TurnState = {
  turnId: string;
  /** Re-chunks streamed assistant markdown at safe render boundaries. */
  joiner: MarkdownJoiner;
  /** The currently-open streamed run, or null (next chunk opens one). */
  run: StreamRun | null;
  /** The user prompt that started this turn (checkpoint commit message). */
  userText: string;
  /**
   * Where this turn's entries land: the collections for live turns
   * (liveEntryWriter), a ReplayStage for a session/load replay. The target
   * rides the turn so the streaming pipeline never branches on task mode.
   */
  entries: AgentEntryWriter;
};

export function contentBlockText(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Some app tools (workspace_read_document, history_restore, author_blob, …)
 * don't get `locations` from the adapter the way native tool calls
 * sometimes do (confirmed absent on every MCP tool_call in
 * docs/architecture/spikes/v2-mcp-passthrough-spike.md). Derive the same
 * shape from the tool's own `path` input so these still show up in
 * file-presence affordances (Stage 3) the same as native ones. Agents send
 * workspace-relative paths (the tool schemas ask for them) while presence
 * and jump affordances key on absolute editor paths — resolve here.
 */
function deriveToolLocations(
  rawInput: unknown,
  workspacePath: string,
): Array<{ path: string }> | undefined {
  if (!isPlainObject(rawInput) || typeof rawInput.path !== "string")
    return undefined;
  const resolved = resolveWorkspacePath(workspacePath, rawInput.path);
  return [{ path: resolved.ok ? resolved.absolute : rawInput.path }];
}

/**
 * Adapters mint their own MCP tool-name prefixes: claude-agent-acp uses
 * `mcp__<serverName>__<toolName>` (v2-mcp-passthrough-spike.md), OpenCode
 * uses `<serverName>_<toolName>` (v2-opencode-config-mcp-spike.md). Strip
 * whichever is present so transcript entries and `findBlobAuthorTask` see
 * the plain tool name, same as any other tool call.
 */
function normalizeMcpToolName(
  title: string | null | undefined,
): string | undefined {
  if (!title) return undefined;
  for (const prefix of [`mcp__${MCP_SERVER_NAME}__`, `${MCP_SERVER_NAME}_`]) {
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
}

/**
 * Extract a message from anything thrown. The ACP library rejects with a plain
 * JSON-RPC `{ code, message }` object (not an Error), so `String(error)` would
 * yield "[object Object]" and lose the reason — including the auth signal.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * A task is the unit of parallel agent work ("rewrite chapter 3" and
 * "fact-check pricing" run concurrently in one workspace). Each AgentTask
 * owns one transport + one ACP connection + one session + its own
 * PermissionBroker and turn state; on desktop procId = taskId, on web the
 * worker maps taskId → child process. Process-per-task: adapters'
 * multi-session support is unproven, and processes give free crash
 * isolation and trivially correct cancellation.
 *
 * The app never holds an AgentTask directly — it drives tasks through the
 * free functions below (startAgentTask/promptAgentTask/…) and reads all state
 * through the agent collections.
 */
export class AgentTask {
  readonly permissionBroker: PermissionBroker;

  private client: NotefigAcpClient | null = null;
  private transport: AgentTransport | null = null;
  private sessionId: string | null = null;

  /**
   * The cwd the agent process runs in. Equals workspacePath on desktop; on a
   * remote worker it's the worker's real folder (transport.agentCwd), since
   * ACP validates cwd on the machine the agent runs on, not this browser.
   */
  private get agentCwd(): string {
    return this.transport?.agentCwd ?? this.workspacePath;
  }
  /**
   * Pre-insert cache only: seeds the row in upsertTaskRow and answers reads
   * before the row exists. Once it does, the row is the source of truth —
   * read through `currentStatus`, write through `setStatus` (the one place
   * allowed to touch either, and a no-op after dispose: dispose owns
   * terminal state — demote/purge decide what the row says).
   */
  private status: AgentTaskStatus = "starting";
  private title = "New task";

  private currentTurn: TurnState | null = null;
  /**
   * toolCallId → event row id. Task-level (not per-turn) so a late
   * tool_call_update — one that arrives at or after the turn boundary — still
   * finds its row and flips the card to its final status instead of getting
   * stuck at pending/in_progress.
   */
  private readonly toolEventIds = new Map<string, string>();
  /**
   * FIFO prompt queue. Prompts arriving while a turn runs stack in send
   * order and run one per turn — nothing is displaced or dropped. Queued
   * prompts are transcript state, not private task state: `prompt()` inserts
   * their user entry + a `"queued"` turn row immediately, and `runTurn`
   * promotes those rows to `"running"` when the queue reaches them.
   */
  private readonly pendingPrompts: {
    turnId: string;
    text: string;
    contextParts?: PromptContextPart[];
  }[] = [];
  /** turnId → resolver for that turn's prompt-handle `completed` promise. */
  private readonly turnResolvers = new Map<
    string,
    (outcome: TurnOutcome) => void
  >();
  /** True while `drainQueue`'s loop is actively running (reentrancy guard). */
  private draining = false;
  /** "How to sign in" hint, surfaced only when an auth error actually occurs. */
  private authHintValue?: string;
  /**
   * The prompt an auth block interrupted; retried after sign-in. Holds the
   * original turnId so the retry re-queues the existing transcript rows
   * instead of inserting a duplicate user entry + turn.
   */
  private heldPrompt?: {
    turnId: string;
    text: string;
    contextParts?: PromptContextPart[];
  };
  /**
   * While auth-blocked, new prompts queue without starting a drain — running
   * them would just fail the same way and displace the held prompt. Cleared
   * by authenticate()/retryHeldPrompt(), which restart the drain.
   */
  private authBlocked = false;
  /** Whether this task wrote a per-task OpenCode config (cleaned up in dispose). */
  private opencodeConfigWritten = false;
  /** True once start() has been called — distinguishes "spawn in flight"
   *  (prompts queue) from "never started" (prompts error immediately). */
  private startCalled = false;
  /** Per-harness signed-in KV mark, written once per task on first success. */
  private signedInMarked = false;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];
  /** Stage 3.5: this task's app-tools MCP endpoint; torn down in dispose(). */
  private mcpEndpoint: McpEndpoint | null = null;

  constructor(
    readonly taskId: string,
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
    /** Set when spawned by another task (subagent pattern, opencode-style) */
    readonly parentTaskId?: string,
  ) {
    this.permissionBroker = new PermissionBroker(taskId);
  }

  /**
   * Spawn transport + connect ACP + create the session. Takes a transport
   * *factory* rather than a transport: the app-tools MCP channel must be
   * live before the harness process spawns, because some harnesses learn
   * about the MCP server through their spawn environment
   * (`mcpRegistration: "opencode-config"` → a per-task config file passed
   * via `OPENCODE_CONFIG`) rather than through `session/new.mcpServers`.
   */
  async start(
    createTransport: (spec: {
      extraEnv: Record<string, string>;
    }) => AgentTransport,
    options?: {
      /**
       * Revival (MET-54): resume this harness-stored session via ACP
       * `session/load` instead of creating a new one. History replays into
       * the transcript before the task goes idle; a failed load lands the
       * row on "unavailable" (the harness no longer has the session).
       */
      resumeSessionId?: string;
    },
  ): Promise<void> {
    this.startCalled = true;
    this.upsertTaskRow();

    try {
      // MCP channel first — the harness spawn may need its address. Same
      // construct-then-start pattern as the ACP transport below:
      // createMcpEndpoint is a dumb sync constructor, we call start()
      // ourselves, and mcpServer only exists on the instance afterward.
      const mcpEndpoint = MOCK_AGENT_MODE
        ? createMockMcpEndpoint()
        : platformAdapter.proc.createMcpEndpoint({ taskId: this.taskId });
      this.mcpEndpoint = mcpEndpoint;
      await mcpEndpoint.start();
      this.unsubscribers.push(
        attachMcpEndpoint(
          mcpEndpoint,
          createMcpRequestHandler({
            ctx: {
              workspacePath: this.workspacePath,
              taskId: this.taskId,
              agents,
            },
            permissionBroker: this.permissionBroker,
            tools: { list: () => toolRegistry, get: getTool },
            translate: (key) => i18n.t(key),
            instructions: serverInstructions,
            buildWidgetContextPayload,
            onUnsupportedProtocolVersion: (requested) =>
              captureEvent("agent_protocol_version_unsupported", {
                protocol: "mcp",
                harness: this.harness.id,
                version: requested ?? "(missing)",
              }),
          }),
        ),
      );

      const extraEnv = await this.prepareHarnessMcpRegistration(
        mcpEndpoint.mcpServer,
      );

      const transport = createTransport({ extraEnv });
      this.transport = transport;
      this.unsubscribers.push(
        transport.onClose((error) => this.handleTransportClose(error)),
      );
      // Adapter stderr — console-only for now (observability lives on the
      // transcript collections; the raw-frame diagnostics stream was removed).
      if (transport.onDiagnostic) {
        this.unsubscribers.push(
          transport.onDiagnostic((line) => this.warn("stderr", line)),
        );
      }

      this.client = new NotefigAcpClient({
        taskId: this.taskId,
        transport,
        permissionBroker: this.permissionBroker,
        onSessionUpdate: (notification) =>
          this.handleSessionUpdate(notification),
        fs: {
          readTextFile: readWorkspaceTextFile,
          writeTextFile: writeWorkspaceTextFile,
        },
        onUnsupportedProtocolVersion: (negotiated) =>
          captureEvent("agent_protocol_version_unsupported", {
            protocol: "acp",
            harness: this.harness.id,
            version: String(negotiated),
          }),
      });

      // Bring the transport live before any ACP traffic; spawn failure
      // surfaces here as an AgentTransportError and marks the task errored.
      await transport.start();
      await withStartupTimeout(this.client.connect(), "initialize");
      // Note: we do NOT surface authHint here — the adapter always advertises
      // authMethods regardless of login (see the auth spike), so the hint only
      // becomes meaningful when a prompt actually fails with "auth required".
      const mcpServers = this.currentMcpServers();
      if (options?.resumeSessionId) {
        await withStartupTimeout(
          this.resumeSession(options.resumeSessionId, mcpServers),
          "session/load",
        );
      } else {
        const session = await withStartupTimeout(
          this.client.newSession(this.agentCwd, mcpServers),
          "session/new",
        );
        this.sessionId = session.sessionId;
      }
      // The sessionId rides the task row — it's what agent-persistence.ts
      // persists and what revival needs back (the old `session:<taskId>` KV
      // side-key is retired; stale keys are inert).
      if (agentTasksCollection.get(this.taskId)) {
        agentTasksCollection.update(this.taskId, (draft) => {
          draft.sessionId = this.sessionId ?? undefined;
        });
      }
      this.setStatus("idle");
      // Prompts that arrived during the spawn/handshake (or replay) queued
      // instead of erroring — run them now.
      if (this.pendingPrompts.length > 0 && !this.authBlocked) {
        void this.drainQueue();
      }
    } catch (error) {
      const message = errorMessage(error);
      this.warn("start failed", message);
      // A REJECTED session/load means the harness no longer has the
      // session — a distinct, deletable end state. A startup TIMEOUT is
      // different: the session may be fine and the adapter just never
      // came up, so it stays a plain (retryable-looking) error. A task
      // disposed mid-start (workspace close; StrictMode's remount cycle
      // when the chat tab auto-revives at boot) fails here LATE — setStatus
      // no-ops once disposed, so the demoted "restored" row is never
      // stomped, and dispose already settled the queued prompts (the
      // splice below is empty).
      const timedOut = error instanceof StartupTimeoutError;
      this.setStatus(
        options?.resumeSessionId && !timedOut ? "unavailable" : "error",
      );
      for (const { turnId } of this.pendingPrompts.splice(0)) {
        this.settleQueuedTurn(turnId, { status: "error", error: message });
      }
      if (!this.disposed) {
        // An errored task has no reason to keep its process: a timed-out or
        // half-connected adapter would otherwise idle until workspace close
        // (dispose handles its own teardown, hence the guard).
        void this.transport?.close().catch(() => {});
        void this.mcpEndpoint?.close().catch(() => {});
      }
      throw error instanceof AgentTransportError ? error : new Error(message);
    }
  }

  /**
   * The mcpServers list for session/new and session/load — derived, not
   * stored: only harnesses with verified session/new pass-through get the
   * entry (capability matrix, not self-reported mcpCapabilities);
   * "opencode-config" harnesses already got theirs via their spawn env.
   */
  private currentMcpServers(): McpServer[] {
    return this.harness.mcpRegistration === "session-new" &&
      this.mcpEndpoint?.mcpServer
      ? [this.mcpEndpoint.mcpServer]
      : [];
  }

  /**
   * ACP `session/load` + replay capture. History replays as session/update
   * notifications BEFORE loadSession resolves (verified on both adapters,
   * MET-54 spike); a synthetic completed turn anchors them so the transcript
   * rebuilds through the normal handleSessionUpdate pipeline — including
   * replayed user messages (the `user_message_chunk` case). The turn writes
   * into a ReplayStage, not the collections: rows kept from this task's
   * previous life (workspace close → reopen) stay visible while history
   * streams, and the stage commits the replayed transcript in one
   * synchronous swap. A failed load drops the stage, so the old transcript
   * stays readable next to the "unavailable" verdict instead of vanishing.
   *
   * `closeFirst` is the manual-refresh variant (refreshFromHarness): ACP
   * `session/close` tears down the agent's in-memory session so the reload
   * rebuilds BOTH the transcript and the model's context from the merged
   * store (spike §4.5 — a repeat load alone re-syncs only the transcript).
   * Best-effort: an adapter without the method still gets the transcript
   * re-sync. The replay turn is set synchronously before the close, so the
   * whole close+load window reads as "a turn is in flight" — prompts queue
   * without kicking the drain into the half-torn session.
   */
  private async resumeSession(
    sessionId: string,
    mcpServers: McpServer[],
    options?: { closeFirst?: boolean },
  ): Promise<void> {
    if (!this.client) throw new Error("ACP client not connected");
    const stage = new ReplayStage();
    const turnId = newTurnId();
    const replayTurn: AgentTurn = {
      turnId,
      taskId: this.taskId,
      sessionId,
      status: "completed",
      stopReason: "replay",
      startedAt: Date.now(),
    };
    // The replay re-establishes tool-call coalescing from scratch — a stale
    // mapping would land a replayed toolCallId on a row the commit deletes.
    this.toolEventIds.clear();
    this.currentTurn = {
      turnId,
      joiner: new MarkdownJoiner(),
      run: null,
      userText: "",
      entries: stage,
    };
    try {
      if (options?.closeFirst) {
        await withStartupTimeout(
          this.client.closeSession(sessionId),
          "session/close",
        ).catch((error) => {
          this.warn(
            "session/close failed; transcript-only re-sync",
            errorMessage(error),
          );
        });
      }
      await this.client.loadSession(sessionId, this.agentCwd, mcpServers);
      // The transport can die while the load is in flight —
      // handleTransportClose drops the staged turn and marks the task
      // errored. Committing the replay past that would hand the caller an
      // "idle" session backed by a dead transport, so abort instead.
      const turn = this.currentTurn;
      if (turn?.turnId !== turnId) {
        throw new Error("agent process ended during session/load");
      }
      this.sessionId = sessionId;
      this.closeRun(turn);
      // Replayed tool calls carry whatever status they streamed with; one
      // still pending/in_progress can't actually be running (this history
      // already happened), and the replay turn never passes through
      // finishTurn — resolve them here so nothing spins forever.
      this.resolveLingeringToolCalls(stage, turnId, "completed");
      // Prompts queued against this revival keep their rows: they aren't
      // part of the replayed history.
      stage.commit(
        replayTurn,
        new Set(this.pendingPrompts.map((p) => p.turnId)),
      );
    } finally {
      this.currentTurn = null;
    }
  }

  /**
   * Pre-spawn MCP registration for harnesses that don't take
   * `session/new.mcpServers`. For "opencode-config": write a per-task
   * OpenCode config registering our stdio server and return
   * `OPENCODE_CONFIG` pointing at it (verified to reach the model —
   * v2-opencode-config-mcp-spike.md). Best-effort: a failed write degrades
   * to "no app tools" rather than failing the task.
   */
  private async prepareHarnessMcpRegistration(
    mcpServer: McpServer | undefined,
  ): Promise<Record<string, string>> {
    if (
      this.harness.mcpRegistration !== "opencode-config" ||
      !mcpServer ||
      !("command" in mcpServer) // only the stdio variant maps to an OpenCode "local" entry
    ) {
      return {};
    }
    const configPath = this.opencodeConfigPath();
    const environment: Record<string, string> = {};
    for (const entry of mcpServer.env ?? [])
      environment[entry.name] = entry.value;
    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [mcpServer.name]: {
          type: "local",
          command: [mcpServer.command, ...mcpServer.args],
          enabled: true,
          environment,
        },
      },
    };
    const result = await platformAdapter.fs.writeFiles([
      { path: configPath, content: JSON.stringify(config, null, 2) },
    ]);
    if (result.failed.length > 0) {
      this.warn(
        "opencode mcp config write failed; task runs without app tools",
      );
      return {};
    }
    this.opencodeConfigWritten = true;
    return { OPENCODE_CONFIG: configPath };
  }

  /** Per-task OpenCode config, under the workspace's own app dir. Every
   * child of that dir bar `scratchpads` is hidden from the walkers, the
   * watcher and both git repos, so no dot prefix is needed here. */
  private opencodeConfigPath(): string {
    return pathutil.join(
      this.workspacePath,
      APP_DIR_NAME,
      "agent",
      `opencode-${this.taskId}.json`,
    );
  }

  /**
   * Send a user prompt. Enqueue always succeeds — this never throws. While a
   * turn runs the prompt queues FIFO, visible in the transcript as a
   * `"queued"` turn row; a task that never started or is disposed resolves
   * the handle as an error/cancelled value instead. The UI may ignore the
   * returned handle (fire-and-forget is lossless); tests and programmatic
   * callers await `completed`.
   */
  prompt(
    text: string,
    options?: {
      contextParts?: PromptContextPart[];
      /** Enqueue ahead of already-queued prompts (held-prompt retry). */
      front?: boolean;
    },
  ): { turnId: string; completed: Promise<TurnOutcome> } {
    const turnId = newTurnId();
    const completed = new Promise<TurnOutcome>((resolve) => {
      this.turnResolvers.set(turnId, resolve);
    });
    const now = Date.now();

    // Queued prompts are transcript state: entry + turn row exist from the
    // moment of send, and runTurn promotes (not re-inserts) them.
    agentEntriesCollection.insert({
      id: newEventId(),
      taskId: this.taskId,
      turnId,
      type: "user",
      text,
      createdAt: now,
    });
    agentTurnsCollection.insert({
      turnId,
      taskId: this.taskId,
      sessionId: this.sessionId ?? "",
      status: "queued",
      startedAt: now,
    });
    // Enqueue is activity even when it doesn't change status (queueing onto
    // a busy task) — bump so the session list orders by last touch.
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.updatedAt = now;
      });
    }

    // Sort the task into one of three states: dead (settle the turn now),
    // spawning (queue — start()'s tail drains, or settles errors on failure),
    // or live (queue + kick the drain unless something already will).
    const hasSession = this.client !== null && this.sessionId !== null;
    const spawning = this.startCalled && this.status === "starting";
    if (this.disposed) {
      this.settleQueuedTurn(turnId, { status: "cancelled" });
      return { turnId, completed };
    }
    if (!hasSession && !spawning) {
      this.settleQueuedTurn(turnId, {
        status: "error",
        error: "agent task is not started",
      });
      return { turnId, completed };
    }

    const entry = { turnId, text, contextParts: options?.contextParts };
    if (options?.front) this.pendingPrompts.unshift(entry);
    else this.pendingPrompts.push(entry);
    // Kick the drain unless a turn is in flight (live or replay — a
    // session/load replay holds currentTurn for its whole window, manual
    // refresh included), a draining loop will pick this up, a sign-in block
    // holds the queue (authenticate()/retryHeldPrompt() restarts it), or
    // the spawn in flight will (start()'s tail).
    if (
      hasSession &&
      !this.currentTurn &&
      !this.draining &&
      !this.authBlocked
    ) {
      void this.drainQueue();
    }
    return { turnId, completed };
  }

  /**
   * Drop one queued prompt (the panel's ✕ on a queued row): delete its
   * transcript rows and resolve its handle cancelled. No-op if the turn
   * already started running.
   */
  removeQueuedPrompt(turnId: string): void {
    const index = this.pendingPrompts.findIndex((p) => p.turnId === turnId);
    if (index === -1) return;
    this.pendingPrompts.splice(index, 1);
    for (const entry of agentEntriesForTask(this.taskId)) {
      if (entry.turnId === turnId) agentEntriesCollection.delete(entry.id);
    }
    agentTurnsCollection.delete(turnId);
    this.resolveTurn(turnId, { status: "cancelled" });
  }

  /** Flip a queued turn's row to its terminal state and resolve its handle. */
  private settleQueuedTurn(
    turnId: string,
    outcome: Extract<TurnOutcome, { status: "cancelled" | "error" }>,
  ): void {
    if (agentTurnsCollection.get(turnId)) {
      agentTurnsCollection.update(turnId, (draft) => {
        draft.status = outcome.status;
        if (outcome.status === "error") draft.error = outcome.error;
      });
    }
    this.resolveTurn(turnId, outcome);
  }

  /** Resolve and clear a turn's prompt-handle promise, if one is pending. */
  private resolveTurn(turnId: string, outcome: TurnOutcome): void {
    const resolve = this.turnResolvers.get(turnId);
    if (!resolve) return;
    this.turnResolvers.delete(turnId);
    resolve(outcome);
  }

  /** Answer a pending permission request this task raised. */
  respondPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): void {
    this.permissionBroker.respond(requestId, response);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.pendingPrompts.length > 0) {
        const { turnId, text, contextParts } = this.pendingPrompts.shift()!;
        const status = await this.runTurn(turnId, text, contextParts);
        // Don't march the rest of the queue through the same failure (e.g.
        // an auth block); remaining rows stay visibly queued and resume on
        // the next successful send.
        if (status === "error") break;
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(
    turnId: string,
    text: string,
    contextParts?: PromptContextPart[],
  ): Promise<AgentTurnStatus> {
    if (!this.client || !this.sessionId) {
      this.settleQueuedTurn(turnId, {
        status: "error",
        error: "agent task is not started",
      });
      return "error";
    }
    const sessionId = this.sessionId;

    // First prompt names the task.
    if (this.title === "New task") {
      this.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.title = this.title;
      });
    }

    // Promote the rows prompt() queued (same ids — the queued row becomes
    // the running row; the user entry is already in the transcript).
    agentTurnsCollection.update(turnId, (draft) => {
      draft.status = "running";
      draft.sessionId = sessionId;
    });

    this.currentTurn = {
      turnId,
      joiner: new MarkdownJoiner(),
      run: null,
      userText: text,
      entries: liveEntryWriter,
    };
    this.setStatus("running");

    try {
      // Tool steering rides the MCP server's own initialize.instructions
      // (mcp-server.ts), not a prompt preamble — prompts carry only user
      // content and context parts.
      const blocks = composePrompt({
        text,
        contextParts,
        capabilities: {
          embeddedContext: this.client.embeddedContextCapability,
        },
      });
      const response = await this.client.prompt(this.sessionId, blocks);
      // A turn that reached the model clears any auth block and marks this
      // harness signed in on this machine (the only reliable signal — there
      // is no ahead-of-time probe, per the auth spike). Written through the
      // KV collection (not platformAdapter.kv.setKv directly) so the harness
      // picker's indicator updates live.
      this.clearAuthBlock();
      if (!this.signedInMarked) {
        this.signedInMarked = true;
        const kv = getOrCreateKvCollection(AGENT_KV_NAMESPACE);
        const key = `auth:${this.harness.id}`;
        if (kv.get(key)) {
          kv.update(key, (draft) => {
            draft.value = true;
          });
        } else {
          kv.insert({ key, value: true });
        }
      }
      return this.finishTurn(response.stopReason, "completed");
    } catch (error) {
      const message = errorMessage(error);
      // Logged-out claude-code-acp fails here with "Authentication required"
      // (docs/architecture/spikes/phase1-auth-spike.md). Auth-blocked state
      // is task-row state: methods + hint land on the row, the failed
      // prompt's text is held for a retry after sign-in.
      if (/authentication required/i.test(message)) {
        this.enterAuthBlock({ turnId, text, contextParts });
      }
      this.warn("turn error", message);
      return this.finishTurn(undefined, "error", message);
    }
  }

  /**
   * ACP `authenticate` with one of the methods on the task row, then retry
   * the held prompt. Fails as a value — for out-of-band methods (terminal
   * logins; both claude-code and OpenCode today) the adapter typically
   * rejects, and the UI falls back to showing the method's description as
   * instructions plus the "I've signed in" retry affordance.
   */
  async authenticate(
    methodId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.client) return { ok: false, error: "agent task is not started" };
    try {
      await this.client.authenticate(methodId);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    this.retryHeldPrompt();
    return { ok: true };
  }

  /**
   * Clear the auth block and re-send the prompt it interrupted (jumping the
   * queue — it was sent before anything queued behind it). Also the "I've
   * signed in" affordance for out-of-band logins: optimistic, since there's
   * no probe — if the user isn't actually signed in, the retry re-raises
   * the block.
   */
  retryHeldPrompt(): void {
    const held = this.heldPrompt;
    this.heldPrompt = undefined;
    this.clearAuthBlock();
    if (this.currentStatus === "error") this.setStatus("idle");
    if (held) {
      // Re-queue the ORIGINAL rows: the failed turn goes back to "queued"
      // (clearing its error also removes the stale "Turn failed" bubble) and
      // its user entry stays put — no duplicate transcript rows. The first
      // attempt's prompt handle already resolved as error (resolveTurn
      // no-ops on the reused turnId), which is fine: programmatic callers
      // saw the auth failure; the retry is UI-driven.
      if (agentTurnsCollection.get(held.turnId)) {
        agentTurnsCollection.update(held.turnId, (draft) => {
          draft.status = "queued";
          draft.error = undefined;
          draft.stopReason = undefined;
        });
      }
      this.pendingPrompts.unshift(held);
      if (!this.currentTurn && !this.draining) {
        void this.drainQueue();
      }
    } else if (
      this.pendingPrompts.length > 0 &&
      !this.currentTurn &&
      !this.draining
    ) {
      // Nothing held, but prompts queued up behind the block — resume them.
      void this.drainQueue();
    }
  }

  /** Auth-blocked is task-row state (Stage 4): methods + hint, held prompt. */
  private enterAuthBlock(held: {
    turnId: string;
    text: string;
    contextParts?: PromptContextPart[];
  }): void {
    this.authBlocked = true;
    this.heldPrompt = held;
    this.authHintValue = this.client?.authHint ?? this.harness.authHint;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.authRequired = true;
        draft.authMethods = this.client?.availableAuthMethods ?? [];
        draft.authHint = this.authHintValue;
      });
    }
  }

  private clearAuthBlock(): void {
    this.authBlocked = false;
    this.authHintValue = undefined;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.authRequired = false;
        draft.authHint = undefined;
      });
    }
  }

  private finishTurn(
    stopReason: string | undefined,
    turnStatus: AgentTurnStatus,
    error?: string,
  ): AgentTurnStatus {
    const turn = this.currentTurn;
    if (!turn) return turnStatus;

    // Land any buffered assistant text before sealing the turn.
    this.closeRun(turn);

    // A finished turn means its tools are no longer running — resolve any that
    // never received a terminal update so nothing spins forever.
    this.resolveLingeringToolCalls(turn.entries, turn.turnId, turnStatus);

    agentTurnsCollection.update(turn.turnId, (draft) => {
      draft.status = turnStatus;
      draft.stopReason = stopReason;
      if (error) draft.error = error;
    });

    this.resolveTurn(
      turn.turnId,
      turnStatus === "error"
        ? { status: "error", error: error ?? "unknown error" }
        : turnStatus === "cancelled"
          ? { status: "cancelled" }
          : { status: "completed", stopReason },
    );

    this.currentTurn = null;
    this.setStatus(turnStatus === "error" ? "error" : "idle");
    if (turnStatus === "completed") {
      void this.checkpointTurn(turn.userText);
    }
    return turnStatus;
  }

  /** Auto-checkpoint (Track D.3): one commit per completed turn, best-effort. */
  private async checkpointTurn(promptText: string): Promise<void> {
    const message =
      promptText.length > 72 ? `${promptText.slice(0, 69)}…` : promptText;
    try {
      await checkpointWorkspaceHistory(this.workspacePath, message, {
        name: this.harness.id,
        email: "agent@notefig.local",
      });
    } catch (error) {
      // Best-effort: history is a convenience, never block/fail the turn on it.
      this.warn("checkpoint failed", errorMessage(error));
    }
  }

  handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;

    // Tool calls coalesce at the task level, so a final tool_call_update that
    // arrives at/after the turn boundary still lands. Handle it before the
    // active-turn guard below.
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      this.upsertToolEntry(update);
      return;
    }

    const turn = this.currentTurn;
    if (!turn) return; // other updates need a turn to attach to

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        // A reply after a thought closes the thought run (order-preserving);
        // assistant text additionally rides the markdown joiner.
        if (turn.run?.kind === "thought") this.closeRun(turn);
        const flushable = turn.joiner.processText(
          contentBlockText(update.content),
        );
        if (flushable) this.appendToRun(turn, "assistant", flushable);
        break;
      }
      case "agent_thought_chunk": {
        const chunk = contentBlockText(update.content);
        if (!chunk) break;
        // A thought after visible text closes the text run (and flushes any
        // markdown the joiner was still buffering, keeping order).
        if (turn.run?.kind !== "thought") this.closeRun(turn);
        this.appendToRun(turn, "thought", chunk);
        break;
      }
      case "plan": {
        // Plans are peers of text/tools; close the open run so a following
        // reply opens a fresh entry after the plan.
        this.closeRun(turn);
        turn.entries.insert({
          id: newEventId(),
          taskId: this.taskId,
          turnId: turn.turnId,
          type: "plan",
          plan: update,
        });
        break;
      }
      case "user_message_chunk": {
        // Only ever observed on session/load replay — live user entries are
        // inserted by prompt() itself, and adapters replay each historical
        // user message as a single chunk (MET-54 spike). Render as a real
        // user bubble so a revived transcript reads like the original.
        const chunk = contentBlockText(update.content);
        if (!chunk) break;
        this.closeRun(turn);
        turn.entries.insert({
          id: newEventId(),
          taskId: this.taskId,
          turnId: turn.turnId,
          type: "user",
          text: chunk,
        });
        break;
      }
      default:
        // D4: available_commands_update / current_mode_update — not rendered
        // yet, but kept as transcript data rather than dropped. Run
        // boundaries are left alone.
        turn.entries.insert({
          id: newEventId(),
          taskId: this.taskId,
          turnId: turn.turnId,
          type: "unknown",
          text: update.sessionUpdate,
          raw: update,
        });
        break;
    }
  }

  /**
   * Coalesce a tool call into one entry keyed by toolCallId: the first tool_call
   * inserts, later updates (pending → in_progress → completed/failed) merge into
   * the same entry so the UI shows one transitioning card, not a stack. Keyed at
   * the task level so updates land even after the turn that started them ends.
   * Tool entries are first-class — not nested under a message.
   *
   * MCP tool names arrive prefixed (`mcp__notefig__author_blob`, confirmed
   * on claude-agent-acp) and without `locations` — normalize the former and
   * derive the latter from `rawInput.path` so app tools render and address
   * (`findBlobAuthorTask`) exactly like any other tool call.
   */
  private upsertToolEntry(
    update: Extract<
      SessionNotification["update"],
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >,
  ): void {
    const toolCallId = update.toolCallId;
    const existingId = toolCallId
      ? this.toolEventIds.get(toolCallId)
      : undefined;
    // No turn (a late tool_call_update at/after the turn boundary) means the
    // row it targets is already committed — write to the collections.
    const entries = this.currentTurn?.entries ?? liveEntryWriter;

    if (existingId) {
      entries.update(existingId, (draft) => {
        const previous = draft.toolCall as ToolCallUpdate | undefined;
        // ACP updates replace each field, so a shallow merge is correct —
        // except title/locations: a later update commonly omits `title`
        // (unchanged since the first tool_call) and may omit `rawInput.path`
        // entirely (e.g. a bare status flip); don't let either regress what
        // an earlier update already established.
        draft.toolCall = {
          ...previous,
          ...update,
          title: normalizeMcpToolName(update.title) ?? previous?.title,
          locations:
            update.locations ??
            deriveToolLocations(update.rawInput, this.workspacePath) ??
            previous?.locations,
        };
      });
      return;
    }

    // A new tool call ends the open text/thought run, so the reply that
    // follows the tool renders below it (correct interleaving).
    if (this.currentTurn) this.closeRun(this.currentTurn);
    const id = newEventId();
    if (toolCallId) this.toolEventIds.set(toolCallId, id);
    entries.insert({
      id,
      taskId: this.taskId,
      turnId: this.currentTurn?.turnId ?? "",
      type: "tool_call",
      toolCallId: toolCallId ?? undefined,
      toolCall: {
        ...update,
        title: normalizeMcpToolName(update.title),
        locations:
          update.locations ??
          deriveToolLocations(update.rawInput, this.workspacePath),
      },
    });
  }

  /**
   * Flip this turn's still-open tool calls to a terminal status matching how
   * the turn ended: completed turns close them as "completed"; errored or
   * cancelled turns close them as "failed" (ACP's ToolCallStatus has no
   * "cancelled" — "failed" is the honest terminal state either way: the
   * tool did not finish). Turnless entries (`turnId: ""` — a tool_call that
   * arrived when no turn was current, e.g. an adapter straggler after
   * cancel) are swept too: no later turn will ever claim them, and they'd
   * otherwise spin forever (MET-104).
   */
  private resolveLingeringToolCalls(
    entries: AgentEntryWriter,
    turnId: string,
    turnStatus: AgentTurnStatus,
  ): void {
    const terminal = turnStatus === "completed" ? "completed" : "failed";
    for (const entry of entries.entriesForTask(this.taskId)) {
      if (entry.type !== "tool_call") continue;
      if (entry.turnId !== turnId && entry.turnId !== "") continue;
      const status = entry.toolCall?.status;
      if (status === "pending" || status === "in_progress" || status == null) {
        entries.update(entry.id, (draft) => {
          if (draft.toolCall) draft.toolCall.status = terminal;
        });
      }
    }
  }

  /**
   * Append streamed text to the turn's open run, opening one (with its
   * transcript entry) if none of this kind is open. Callers close a
   * different-kind run first — this only extends or opens.
   */
  private appendToRun(
    turn: TurnState,
    kind: StreamRun["kind"],
    text: string,
  ): void {
    if (!turn.run || turn.run.kind !== kind) {
      turn.run = { kind, entryId: newEventId(), text };
      turn.entries.insert({
        id: turn.run.entryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: kind,
        text,
      });
      return;
    }
    turn.run.text += text;
    const { entryId, text: runText } = turn.run;
    turn.entries.update(entryId, (draft) => {
      draft.text = runText;
    });
  }

  /**
   * Close the open run; the next chunk opens a fresh entry (that boundary is
   * what keeps thought/text/tool/plan entries chronological). Flushes the
   * markdown joiner first so assistant text it was still buffering (awaiting
   * a safe render boundary) lands before whatever interrupted it — the
   * joiner only ever holds assistant text, so its buffer is empty whenever a
   * thought run is the one being closed.
   */
  private closeRun(turn: TurnState): void {
    const tail = turn.joiner.flush();
    if (tail) this.appendToRun(turn, "assistant", tail);
    // Models emit whitespace-only chunks around tool calls ("\n\n" before a
    // tool_call opens a run that nothing else joins); a closed run that never
    // got visible text is transcript noise — drop its entry.
    if (turn.run && !turn.run.text.trim()) {
      turn.entries.delete(turn.run.entryId);
    }
    turn.run = null;
  }

  /**
   * session/cancel + resolve this task's pending permissions as cancelled.
   * Queued prompts drain too: each handle resolves cancelled and its turn
   * row flips to "cancelled" (rows persist in the transcript). Other tasks
   * are untouched.
   */
  async cancel(): Promise<void> {
    this.permissionBroker.cancelAll();
    for (const { turnId } of this.pendingPrompts.splice(0)) {
      this.settleQueuedTurn(turnId, { status: "cancelled" });
    }
    // A replay in flight isn't a cancellable turn: its synthetic turn row
    // lives in the stage (finishTurn would update a row that isn't in the
    // collection yet), and session/load runs to completion regardless.
    const replaying = this.currentTurn?.entries instanceof ReplayStage;
    if (this.client && this.sessionId && this.currentTurn && !replaying) {
      try {
        await this.client.cancel(this.sessionId);
      } catch {
        // best-effort; the process may already be gone
      }
      this.finishTurn("cancelled", "cancelled");
      this.setStatus("cancelled");
    }
  }

  /**
   * cancel(), then delete the aborted running turn's transcript rows — the
   * Escape-to-restore path (MET-94): the prompt text goes back into the
   * composer, so its round must not linger in the history it was pulled
   * out of (mirrors removeQueuedPrompt's row cleanup for queued turns).
   *
   * Forgetting is only coherent while the agent hasn't responded yet: once
   * assistant output / tool calls exist, the harness's session context
   * contains a real exchange, and hiding it would leave the transcript
   * disagreeing with what the agent knows. So the responded check runs
   * AFTER cancel() resolves (finishTurn has settled the rows by then —
   * race-free), and a turn with any non-user entry keeps its rows as a
   * plain cancelled round. Returns whether the turn was forgotten, so the
   * caller knows whether to restore the prompt into the composer.
   */
  async cancelAndForgetTurn(): Promise<boolean> {
    const turnId = this.currentTurn?.turnId;
    await this.cancel();
    if (!turnId) return false;
    const turnEntries = agentEntriesForTask(this.taskId).filter(
      (entry) => entry.turnId === turnId,
    );
    if (turnEntries.some((entry) => entry.type !== "user")) return false;
    for (const entry of turnEntries) agentEntriesCollection.delete(entry.id);
    agentTurnsCollection.delete(turnId);
    return true;
  }

  /**
   * Re-sync this live task from the harness's own session store. ACP has no
   * change feed — a turn appended by another process (`claude --resume` in a
   * terminal) surfaces only through a fresh `session/load`. `session/close`
   * first tears down the adapter's in-memory session so the reload rebuilds
   * BOTH the transcript and the model's context from the merged store
   * (verified against claude-agent-acp — a repeat load alone re-syncs only
   * the transcript; docs/architecture/acp-two-way-spike.md §4.5). Close is
   * best-effort: an adapter without the method still gets the transcript
   * re-sync. Refusing to run mid-turn also keeps the fork hazard shut —
   * prompting a session that went stale under an external append forks the
   * harness's history tree and orphans the external branch.
   */
  async refreshFromHarness(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    if (!this.client || !this.sessionId) {
      return { ok: false, error: "agent task is not started" };
    }
    if (this.currentTurn || this.draining) {
      return { ok: false, error: "a turn is in progress" };
    }
    const sessionId = this.sessionId;
    // "starting" + a sessionId is the UI's session-loading state (MET-54) —
    // the composer holds input exactly as it does during revival.
    this.setStatus("starting");
    let resynced = false;
    try {
      // resumeSession installs its replay turn synchronously, so the whole
      // close+load window reads as "a turn is in flight" to prompt() — no
      // extra mode flag needed to keep the drain off the half-torn session.
      await withStartupTimeout(
        this.resumeSession(sessionId, this.currentMcpServers(), {
          closeFirst: true,
        }),
        "session/load",
      );
      this.setStatus("idle");
      resynced = true;
      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      this.warn("session refresh failed", message);
      this.setStatus("error");
      return { ok: false, error: message };
    } finally {
      // Prompts sent during the refresh queued (see prompt()); run them now.
      // Only after a successful re-sync: a failed refresh can mean a dead
      // transport (handleTransportClose dropped the replay turn), and
      // draining would shove the queue into it — the prompts stay queued
      // (visible rows) instead.
      if (
        resynced &&
        this.pendingPrompts.length > 0 &&
        !this.authBlocked &&
        !this.currentTurn &&
        !this.draining
      ) {
        void this.drainQueue();
      }
    }
  }

  get authHint(): string | undefined {
    return this.authHintValue;
  }

  get currentStatus(): AgentTaskStatus {
    // The row is the source of truth once it exists (external writers like
    // the workspace-dispose demotion touch it directly); the field only
    // answers for the gap before upsertTaskRow's insert lands.
    return agentTasksCollection.get(this.taskId)?.status ?? this.status;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const { turnId } of this.pendingPrompts.splice(0)) {
      this.settleQueuedTurn(turnId, { status: "cancelled" });
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    await this.cancel();
    await Promise.all([this.transport?.close(), this.mcpEndpoint?.close()]);
    if (this.opencodeConfigWritten) {
      // Best-effort: a stale per-task config is inert (nothing points at it).
      void platformAdapter.fs
        .deleteFiles([this.opencodeConfigPath()])
        .catch(() => {});
    }
  }

  /** Residual observability: signals that used to land in the diagnostics stream. */
  private warn(label: string, detail?: unknown): void {
    console.warn(`[agent ${this.taskId}] ${label}`, detail ?? "");
  }

  private upsertTaskRow(): void {
    const existing = agentTasksCollection.get(this.taskId);
    if (existing) {
      // Revival: adopt the restored row — its title is the original first
      // prompt (so runTurn's first-prompt naming won't rename it) and its
      // createdAt stands; only the lifecycle fields flip.
      this.title = existing.title;
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.status = this.status;
        draft.updatedAt = Date.now();
      });
      return;
    }
    agentTasksCollection.insert({
      taskId: this.taskId,
      parentTaskId: this.parentTaskId,
      workspacePath: this.workspacePath,
      title: this.title,
      status: this.status,
      harnessId: this.harness.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  private setStatus(status: AgentTaskStatus): void {
    // Dispose owns terminal state: any status write racing in after dispose
    // (a late start() failure, a straggling event) must not stomp what
    // demote/purge decided the row says. One guard here covers every path.
    if (this.disposed) return;
    this.status = status;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.status = status;
        draft.updatedAt = Date.now();
      });
    }
  }

  private handleTransportClose(error?: AgentTransportError): void {
    // Dispose owns terminal state: it killed this transport itself, already
    // cancelled permissions/turns, and the row may since have been demoted
    // to "restored" — a late close event must not stomp any of that.
    if (this.disposed) return;
    this.permissionBroker.cancelAll();
    // "agent process exited (code N)" / "terminated (signal)" from the
    // transport — the difference between a silent dead task and a real reason.
    this.warn("transport closed", error?.message ?? "transport closed");
    if (this.currentTurn?.entries instanceof ReplayStage) {
      // A replay turn is staged, not a real turn row — finishTurn would
      // update a turn that was never inserted. Drop the stage (resumeSession
      // sees the cleared turn and aborts its commit) and record the error.
      this.currentTurn = null;
      this.setStatus("error");
    } else if (this.currentTurn) {
      this.finishTurn(
        undefined,
        "error",
        error?.message ?? "agent process ended",
      );
    } else if (this.currentStatus !== "unavailable") {
      // "unavailable" (failed session/load) must survive the adapter process
      // exiting afterward — it's a distinct, deletable end state, not an error.
      this.setStatus("error");
    }
  }
}

/**
 * Per-workspace task registry (registry convention: git-service-store.ts).
 * Owns workspace-level policy: trust confirmation before the first spawn,
 * harness config from settings — never from document content.
 */
export class TaskManager {
  private readonly tasks = new Map<string, AgentTask>();

  constructor(readonly workspacePath: string) {}

  createTask(
    harness: HarnessDefinition,
    options?: { parentTaskId?: string },
  ): AgentTask {
    // Descending id: any lexicographically sorted task list is newest-first.
    return this.adoptTask(newTaskId(), harness, options?.parentTaskId);
  }

  /** Revival: rebuild the runtime for a restored row under its ORIGINAL
   *  taskId so transcript rows and `agent:<taskId>` layout tabs stay valid. */
  adoptTask(
    taskId: string,
    harness: HarnessDefinition,
    parentTaskId?: string,
  ): AgentTask {
    const task = new AgentTask(
      taskId,
      this.workspacePath,
      harness,
      parentTaskId,
    );
    this.tasks.set(taskId, task);
    registerTask(task);
    return task;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): AgentTask[] {
    return [...this.tasks.values()];
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    unregisterTask(taskId);
    await task?.dispose();
  }

  async disposeAll(): Promise<void> {
    const tasks = this.listTasks();
    this.tasks.clear();
    for (const task of tasks) unregisterTask(task.taskId);
    await Promise.all(tasks.map((task) => task.dispose()));
  }
}

const taskManagerRegistry = new Map<string, TaskManager>();

/**
 * Which task authored a given blob, and its type/path — read straight off
 * the `author_blob` tool call's transcript entry (every fence tool call
 * already gets one, with `rawInput` verbatim), rather than a dedicated
 * blob-tracking table. Used by `answerBlob` (blob-actions.ts) to address a
 * fresh prompt back at the right session once the user interacts with the
 * blob; the answer is a plain prompt, no interaction bookkeeping.
 *
 * Deliberately a full scan (not the taskId index): the lookup is by blobId
 * ACROSS tasks, and it runs once per user blob interaction — rare enough
 * that a dedicated index isn't worth its bookkeeping.
 */
export function findBlobAuthorTask(
  blobId: string,
): { taskId: string; blobType: string; path: string } | undefined {
  const entry = agentEntriesCollection.toArray.find(
    (e) =>
      e.type === "tool_call" &&
      e.toolCall?.title === "author_blob" &&
      isPlainObject(e.toolCall.rawInput) &&
      e.toolCall.rawInput.id === blobId,
  );
  if (!entry?.toolCall?.rawInput) return undefined;
  const rawInput = entry.toolCall.rawInput as { path: string; type: string };
  return { taskId: entry.taskId, blobType: rawInput.type, path: rawInput.path };
}

export function getWorkspaceTaskManager(
  workspacePath: string,
): TaskManager | undefined {
  return taskManagerRegistry.get(workspaceKey(workspacePath));
}

export function getOrCreateWorkspaceTaskManager(
  workspacePath: string,
): TaskManager {
  // Registry key vs value: workspaceKey collapses Windows respellings onto
  // one manager, while the manager itself holds the native spelling — it is
  // the spawn cwd and the persisted task rows' workspacePath.
  const key = workspaceKey(workspacePath);
  let manager = taskManagerRegistry.get(key);
  if (!manager) {
    manager = new TaskManager(pathutil.normalize(workspacePath));
    taskManagerRegistry.set(key, manager);
  }
  return manager;
}

/**
 * Create + start an agent task in a workspace. Owns the platform transport
 * choice so the UI never touches transport internals. Returns synchronously:
 * the task row exists (status "starting") before this returns, so the UI can
 * open the session's tab immediately — spawn + handshake take seconds, and a
 * failed start lands on the row as status "error" rather than swallowing the
 * session. `started` settles when the session is ready; await it before
 * prompting programmatically.
 */
export function startAgentTask(
  workspacePath: string,
  harness: HarnessDefinition,
): { taskId: string; started: Promise<void> } {
  const manager = getOrCreateWorkspaceTaskManager(workspacePath);
  const task = manager.createTask(harness);
  // start() inserts the task row synchronously before its first await.
  return { taskId: task.taskId, started: task.start(transportFactory(task)) };
}

/** The one place a task's spawn spec meets the platform transport. */
function transportFactory(task: AgentTask) {
  if (MOCK_AGENT_MODE) return () => createMockAgentTransport();
  return ({ extraEnv }: { extraEnv: Record<string, string> }) =>
    platformAdapter.proc.createAgentTransport({
      taskId: task.taskId,
      harness: task.harness,
      workspacePath: task.workspacePath,
      extraEnv,
    });
}

/**
 * The effective (overridden/custom-aware) definition for a harness id,
 * read synchronously off the harness-settings KV collection — revival must
 * register the task in the same tick so a prompt can queue immediately.
 * Falls back to the built-in definition when settings aren't loaded yet.
 */
function effectiveHarnessById(
  harnessId: string,
): HarnessDefinition | undefined {
  const kv = getOrCreateKvCollection(HARNESS_SETTINGS_NAMESPACE);
  const overrides = parseHarnessOverrides(kv.get(HARNESS_OVERRIDES_KEY)?.value);
  const custom = parseCustomHarnessEntries(kv.get(HARNESS_CUSTOM_KEY)?.value);
  return (
    resolveEffectiveHarnesses(overrides, custom).find(
      (h) => h.id === harnessId,
    ) ?? BUILT_IN_HARNESSES.find((h) => h.id === harnessId)
  );
}

/**
 * Revive a restored session (MET-54): rebuild its runtime under the original
 * taskId and resume the harness-stored session via `session/load` — history
 * replays into the transcript and the task is simply live again. Returns
 * null when there's nothing to do (already live, no restored row) or when
 * revival is impossible (harness definition gone → row flips to
 * "unavailable"). The task is REGISTERED synchronously, so callers may
 * enqueue prompts immediately; they ride the queue until the load completes.
 */
export function reviveAgentTask(
  taskId: string,
): { started: Promise<void> } | null {
  if (getRegisteredTask(taskId)) return null;
  const row = agentTasksCollection.get(taskId);
  if (!row || row.status !== "restored" || !row.sessionId) return null;
  const harness = effectiveHarnessById(row.harnessId);
  if (!harness) {
    agentTasksCollection.update(taskId, (draft) => {
      draft.status = "unavailable";
      draft.updatedAt = Date.now();
    });
    return null;
  }
  const manager = getOrCreateWorkspaceTaskManager(row.workspacePath);
  const task = manager.adoptTask(taskId, harness, row.parentTaskId);
  const started = task.start(transportFactory(task), {
    resumeSessionId: row.sessionId,
  });
  // Failure lands on the row as "unavailable"/"error" — callers may still await.
  started.catch((error) => {
    console.warn("Agent session revival failed:", errorMessage(error));
  });
  return { started };
}

/**
 * Remove a session everywhere: live runtime (if any), transcript rows, and
 * the persisted row (the task-row delete propagates to KV through the
 * persistence subscriber). The "unavailable" delete affordance; also the
 * building block for MET-55's per-task clear.
 */
export async function deleteAgentSession(taskId: string): Promise<void> {
  const row = agentTasksCollection.get(taskId);
  if (row) {
    await getWorkspaceTaskManager(row.workspacePath)?.cancelTask(taskId);
  }
  purgeTaskRows(taskId);
}

/**
 * The live AgentTask for an id, transparently reviving a restored session
 * first (MET-54): revival registers the task synchronously, so the returned
 * task accepts prompts immediately — they ride the queue while session/load
 * replays history. Undefined = the task doesn't exist or can't be revived.
 */
export function getOrReviveTask(taskId: string): AgentTask | undefined {
  const task = getRegisteredTask(taskId);
  if (task) return task;
  reviveAgentTask(taskId);
  return getRegisteredTask(taskId);
}

/** Send a prompt to a task (fire-and-forget; FIFO queue, lossless). */
export function promptAgentTask(
  taskId: string,
  text: string,
  contextParts?: PromptContextPart[],
): void {
  getOrReviveTask(taskId)?.prompt(text, { contextParts });
}

/** Remove one queued (not yet running) prompt from a task's queue. */
export function removeQueuedPrompt(taskId: string, turnId: string): void {
  getRegisteredTask(taskId)?.removeQueuedPrompt(turnId);
}

/** Cancel a task's running turn and pending permissions. */
export async function cancelAgentTask(taskId: string): Promise<void> {
  await getRegisteredTask(taskId)?.cancel();
}

/**
 * The transcript's manual "refresh session" control: pull whatever the
 * harness's session store holds now — including turns appended by other
 * processes — back into the task. Live tasks re-sync in place
 * (session/close + session/load, see AgentTask.refreshFromHarness);
 * restored rows just revive, which IS a fresh load. Fire-and-forget like
 * the other UI entry points; failures land on the task row as status.
 */
export function refreshAgentSession(taskId: string): void {
  const task = getRegisteredTask(taskId);
  if (task) {
    void task.refreshFromHarness();
    return;
  }
  reviveAgentTask(taskId);
}

/**
 * Cancel the running turn and, if the agent hadn't responded yet, remove
 * its rows from the transcript — Escape-to-restore (MET-94). Resolves true
 * when the turn was forgotten (the caller should restore the prompt into
 * the composer); false when a response already existed and the round stays
 * as a plain cancelled turn.
 */
export async function cancelAgentTurnAndForget(
  taskId: string,
): Promise<boolean> {
  return (await getRegisteredTask(taskId)?.cancelAndForgetTurn()) ?? false;
}

/**
 * ACP `authenticate` with one of the task row's `authMethods`, retrying the
 * held prompt on success. Errors as values (out-of-band methods reject).
 */
export async function authenticateAgentTask(
  taskId: string,
  methodId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const task = getRegisteredTask(taskId);
  if (!task) return { ok: false, error: "agent task is not started" };
  return task.authenticate(methodId);
}

/** "I've signed in" — clear the auth block and retry the held prompt. */
export function retryAgentTaskAfterAuth(taskId: string): void {
  getRegisteredTask(taskId)?.retryHeldPrompt();
}

/** Answer a pending permission request (rows flow via the collection). */
export function respondToAgentPermission(
  taskId: string,
  requestId: string,
  response: RequestPermissionResponse,
): void {
  getRegisteredTask(taskId)?.respondPermission(requestId, response);
}

/**
 * Dispose every workspace's task manager at once — the web tunnel's
 * disconnect teardown. Losing the socket kills every agent on the worker, so
 * all live tasks go down together; each workspace's sessionful rows demote to
 * "restored" for revival on reconnect, exactly as a per-workspace close does.
 */
export async function disposeAllWorkspaceTaskManagers(): Promise<void> {
  const workspaces = Array.from(taskManagerRegistry.keys());
  for (const workspacePath of workspaces) {
    await disposeWorkspaceTaskManager(workspacePath);
  }
}

export async function disposeWorkspaceTaskManager(
  workspacePath: string,
): Promise<void> {
  const key = workspaceKey(workspacePath);
  const manager = taskManagerRegistry.get(key);
  taskManagerRegistry.delete(key);
  await manager?.disposeAll();
  // Sessions outlive their runtimes: rows with a sessionId go back to
  // "restored" — the same live-but-unspawned state they'd have after a
  // restart — so closing/reopening a workspace (or a StrictMode remount)
  // never deletes anything. Rows that never got a session can't revive;
  // drop them. Both write through the storage-backed collection.
  for (const task of agentTasksCollection.toArray) {
    if (workspaceKey(task.workspacePath) !== key) continue;
    if (task.sessionId) {
      agentTasksCollection.update(task.taskId, (draft) => {
        draft.status = "restored";
        draft.authRequired = false;
      });
    } else {
      purgeTaskRows(task.taskId);
    }
  }
}

/** Drop one task's rows from every agent collection (memory only — whether
 *  the task-row delete reaches KV is the caller's suppression choice). */
function purgeTaskRows(taskId: string): void {
  for (const entry of agentEntriesForTask(taskId)) {
    agentEntriesCollection.delete(entry.id);
  }
  for (const turn of agentTurnsForTask(taskId)) {
    agentTurnsCollection.delete(turn.turnId);
  }
  for (const request of agentPermissionRequestsCollection.toArray) {
    if (request.taskId === taskId) {
      agentPermissionRequestsCollection.delete(request.id);
    }
  }
  if (agentTasksCollection.get(taskId)) agentTasksCollection.delete(taskId);
}
