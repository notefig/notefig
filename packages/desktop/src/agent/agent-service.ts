import {
  newTaskId,
  newTurnId,
  newEventId,
  BUILT_IN_HARNESSES,
  composePrompt,
  MCP_SERVER_NAME,
  type ContentBlock,
  type HarnessDefinition,
  type McpServer,
  type PromptContextPart,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
  type TurnOutcome,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath, resolveWorkspacePath } from "@/utils/fs";
import { getOrCreateKvCollection } from "@/utils/kv-store";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { PermissionBroker } from "./permission-broker";
import { MetristsAcpClient } from "./acp-client";
import type { AgentTransport, McpEndpoint } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import { attachMcpEndpoint, createMcpRequestHandler } from "./mcp-server";
import { checkpointWorkspaceHistory } from "@/utils/history-service";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentTaskStatus,
  type AgentTurnStatus,
} from "./agent-collections";
import { getRegisteredTask, registerTask, unregisterTask } from "./task-registry";
// The one `agents` facade (ToolContext.agents). Deferred-use import: this
// module ↔ agents.ts reference each other only inside function bodies, never
// at module-eval time, so evaluation order is a non-issue.
import { agents } from "./agents";

/** KV namespace for agent state (sessionId per task, workspace trust flag). */
const AGENT_KV_NAMESPACE = "agent";

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
  if (!isPlainObject(rawInput) || typeof rawInput.path !== "string") return undefined;
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
function normalizeMcpToolName(title: string | null | undefined): string | undefined {
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

  private client: MetristsAcpClient | null = null;
  private transport: AgentTransport | null = null;
  private sessionId: string | null = null;
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
  /** The prompt text an auth block interrupted; retried after sign-in. */
  private heldPromptText?: string;
  /**
   * While auth-blocked, new prompts queue without starting a drain — running
   * them would just fail the same way and displace the held prompt. Cleared
   * by authenticate()/retryHeldPrompt(), which restart the drain.
   */
  private authBlocked = false;
  /** Whether this task wrote a per-task OpenCode config (cleaned up in dispose). */
  private opencodeConfigWritten = false;
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
    createTransport: (spec: { extraEnv: Record<string, string> }) => AgentTransport,
  ): Promise<void> {
    this.insertTaskRow();

    try {
      // MCP channel first — the harness spawn may need its address. Same
      // construct-then-start pattern as the ACP transport below:
      // createMcpEndpoint is a dumb sync constructor, we call start()
      // ourselves, and mcpServer only exists on the instance afterward.
      const mcpEndpoint = platformAdapter.createMcpEndpoint({ taskId: this.taskId });
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

      this.client = new MetristsAcpClient({
        taskId: this.taskId,
        transport,
        permissionBroker: this.permissionBroker,
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
      });

      // Bring the transport live before any ACP traffic; spawn failure
      // surfaces here as an AgentTransportError and marks the task errored.
      await transport.start();
      await this.client.connect();
      // Note: we do NOT surface authHint here — the adapter always advertises
      // authMethods regardless of login (see the auth spike), so the hint only
      // becomes meaningful when a prompt actually fails with "auth required".
      const session = await this.client.newSession(
        this.workspacePath,
        // Only harnesses with verified session/new pass-through get the
        // entry here (capability matrix, not self-reported mcpCapabilities);
        // "opencode-config" harnesses already got it via their spawn env.
        this.harness.mcpRegistration === "session-new" && mcpEndpoint.mcpServer
          ? [mcpEndpoint.mcpServer]
          : [],
      );
      this.sessionId = session.sessionId;
      // Persist per task even though session/load waits until Phase 4.
      await platformAdapter.setKv(
        AGENT_KV_NAMESPACE,
        `session:${this.taskId}`,
        session.sessionId,
      );
      this.setStatus("idle");
    } catch (error) {
      const message = errorMessage(error);
      this.warn("start failed", message);
      this.setStatus("error");
      throw error instanceof AgentTransportError ? error : new Error(message);
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
    for (const entry of mcpServer.env ?? []) environment[entry.name] = entry.value;
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
    const result = await platformAdapter.writeFiles([
      { path: configPath, content: JSON.stringify(config, null, 2) },
    ]);
    if (result.failed.length > 0) {
      this.warn("opencode mcp config write failed; task runs without app tools");
      return {};
    }
    this.opencodeConfigWritten = true;
    return { OPENCODE_CONFIG: configPath };
  }

  /** Per-task OpenCode config, under the workspace's own `.metrists/`. */
  private opencodeConfigPath(): string {
    return `${this.workspacePath}/.metrists/agent/opencode-${this.taskId}.json`;
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

    if (this.disposed) {
      this.settleQueuedTurn(turnId, { status: "cancelled" });
      return { turnId, completed };
    }
    if (!this.client || !this.sessionId) {
      this.settleQueuedTurn(turnId, {
        status: "error",
        error: "agent task is not started",
      });
      return { turnId, completed };
    }

    const entry = { turnId, text, contextParts: options?.contextParts };
    if (options?.front) this.pendingPrompts.unshift(entry);
    else this.pendingPrompts.push(entry);
    // A running (or actively draining) loop will pick this up; otherwise start
    // one — unless sign-in is pending, in which case rows queue visibly until
    // authenticate()/retryHeldPrompt() restarts the drain.
    if (!this.currentTurn && !this.draining && !this.authBlocked) {
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
    for (const entry of agentEntriesCollection.toArray) {
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
  respondPermission(requestId: string, response: RequestPermissionResponse): void {
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
    };
    this.setStatus("running");

    try {
      // Tool steering rides the MCP server's own initialize.instructions
      // (mcp-server.ts), not a prompt preamble — prompts carry only user
      // content and context parts.
      const blocks = composePrompt({
        text,
        contextParts,
        capabilities: { embeddedContext: this.client.embeddedContextCapability },
      });
      const response = await this.client.prompt(this.sessionId, blocks);
      // A turn that reached the model clears any auth block and marks this
      // harness signed in on this machine (the only reliable signal — there
      // is no ahead-of-time probe, per the auth spike). Written through the
      // KV collection (not platformAdapter.setKv directly) so the harness
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
        this.enterAuthBlock(text);
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
  async authenticate(methodId: string): Promise<{ ok: true } | { ok: false; error: string }> {
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
    const text = this.heldPromptText;
    this.heldPromptText = undefined;
    this.clearAuthBlock();
    if (this.status === "error") this.setStatus("idle");
    if (text) {
      this.prompt(text, { front: true });
    } else if (this.pendingPrompts.length > 0 && !this.currentTurn && !this.draining) {
      // Nothing held, but prompts queued up behind the block — resume them.
      void this.drainQueue();
    }
  }

  /** Auth-blocked is task-row state (Stage 4): methods + hint, held prompt. */
  private enterAuthBlock(promptText: string): void {
    this.authBlocked = true;
    this.heldPromptText = promptText;
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
    this.resolveLingeringToolCalls(turn.turnId, turnStatus);

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
        email: "agent@metrists.local",
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
        const flushable = turn.joiner.processText(contentBlockText(update.content));
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
        agentEntriesCollection.insert({
          id: newEventId(),
          taskId: this.taskId,
          turnId: turn.turnId,
          type: "plan",
          plan: update,
          createdAt: Date.now(),
        });
        break;
      }
      default:
        // D4: user_message_chunk / available_commands_update /
        // current_mode_update — not rendered yet, but kept as transcript
        // data rather than dropped. Run boundaries are left alone.
        agentEntriesCollection.insert({
          id: newEventId(),
          taskId: this.taskId,
          turnId: turn.turnId,
          type: "unknown",
          text: update.sessionUpdate,
          raw: update,
          createdAt: Date.now(),
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
   * MCP tool names arrive prefixed (`mcp__metrists__author_blob`, confirmed
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

    if (existingId) {
      agentEntriesCollection.update(existingId, (draft) => {
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
            update.locations ?? deriveToolLocations(update.rawInput, this.workspacePath) ?? previous?.locations,
        };
      });
      return;
    }

    // A new tool call ends the open text/thought run, so the reply that
    // follows the tool renders below it (correct interleaving).
    if (this.currentTurn) this.closeRun(this.currentTurn);
    const id = newEventId();
    if (toolCallId) this.toolEventIds.set(toolCallId, id);
    agentEntriesCollection.insert({
      id,
      taskId: this.taskId,
      turnId: this.currentTurn?.turnId ?? "",
      type: "tool_call",
      toolCallId: toolCallId ?? undefined,
      toolCall: {
        ...update,
        title: normalizeMcpToolName(update.title),
        locations: update.locations ?? deriveToolLocations(update.rawInput, this.workspacePath),
      },
      createdAt: Date.now(),
    });
  }

  /**
   * Flip this turn's still-open tool calls to a terminal status matching how
   * the turn ended: completed turns close them as "completed"; errored or
   * cancelled turns close them as "failed" (ACP's ToolCallStatus has no
   * "cancelled" — "failed" is the honest terminal state either way: the
   * tool did not finish).
   */
  private resolveLingeringToolCalls(
    turnId: string,
    turnStatus: AgentTurnStatus,
  ): void {
    const terminal = turnStatus === "completed" ? "completed" : "failed";
    for (const entry of agentEntriesCollection.toArray) {
      if (entry.type !== "tool_call" || entry.turnId !== turnId) continue;
      const status = entry.toolCall?.status;
      if (status === "pending" || status === "in_progress" || status == null) {
        agentEntriesCollection.update(entry.id, (draft) => {
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
  private appendToRun(turn: TurnState, kind: StreamRun["kind"], text: string): void {
    if (!turn.run || turn.run.kind !== kind) {
      turn.run = { kind, entryId: newEventId(), text };
      agentEntriesCollection.insert({
        id: turn.run.entryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: kind,
        text,
        createdAt: Date.now(),
      });
      return;
    }
    turn.run.text += text;
    const { entryId, text: runText } = turn.run;
    agentEntriesCollection.update(entryId, (draft) => {
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
    if (this.client && this.sessionId && this.currentTurn) {
      try {
        await this.client.cancel(this.sessionId);
      } catch {
        // best-effort; the process may already be gone
      }
      this.finishTurn("cancelled", "cancelled");
      this.setStatus("cancelled");
    }
  }

  get authHint(): string | undefined {
    return this.authHintValue;
  }

  get currentStatus(): AgentTaskStatus {
    return this.status;
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
      void platformAdapter.deleteFiles([this.opencodeConfigPath()]).catch(() => {});
    }
  }

  // ===== internal helpers =====

  /** Residual observability: signals that used to land in the diagnostics stream. */
  private warn(label: string, detail?: unknown): void {
    console.warn(`[agent ${this.taskId}] ${label}`, detail ?? "");
  }

  private insertTaskRow(): void {
    agentTasksCollection.insert({
      taskId: this.taskId,
      parentTaskId: this.parentTaskId,
      workspacePath: this.workspacePath,
      title: this.title,
      status: this.status,
      harnessId: this.harness.id,
      createdAt: Date.now(),
    });
  }

  private setStatus(status: AgentTaskStatus): void {
    this.status = status;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.status = status;
      });
    }
  }

  private handleTransportClose(error?: AgentTransportError): void {
    this.permissionBroker.cancelAll();
    // "agent process exited (code N)" / "terminated (signal)" from the
    // transport — the difference between a silent dead task and a real reason.
    this.warn("transport closed", error?.message ?? "transport closed");
    if (this.currentTurn) {
      this.finishTurn(undefined, "error", error?.message ?? "agent process ended");
    } else if (!this.disposed) {
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
    const taskId = newTaskId();
    const task = new AgentTask(
      taskId,
      this.workspacePath,
      harness,
      options?.parentTaskId,
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
  return taskManagerRegistry.get(normalizePath(workspacePath));
}

export function getOrCreateWorkspaceTaskManager(
  workspacePath: string,
): TaskManager {
  const normalized = normalizePath(workspacePath);
  let manager = taskManagerRegistry.get(normalized);
  if (!manager) {
    manager = new TaskManager(normalized);
    taskManagerRegistry.set(normalized, manager);
  }
  return manager;
}

// ===== app-facing command API (thin free functions; state via collections) =====

/**
 * Create + start an agent task in a workspace, returning its id. Owns the
 * platform transport choice so the UI never touches transport internals.
 */
export async function startAgentTask(
  workspacePath: string,
  harness: HarnessDefinition = BUILT_IN_HARNESSES[0],
): Promise<string> {
  const manager = getOrCreateWorkspaceTaskManager(workspacePath);
  const task = manager.createTask(harness);
  await task.start(({ extraEnv }) =>
    platformAdapter.createAgentTransport({
      taskId: task.taskId,
      harness,
      workspacePath,
      extraEnv,
    }),
  );
  return task.taskId;
}

/** Send a prompt to a task (fire-and-forget; FIFO queue, lossless). */
export function promptAgentTask(
  taskId: string,
  text: string,
  contextParts?: PromptContextPart[],
): void {
  getRegisteredTask(taskId)?.prompt(text, { contextParts });
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

export async function disposeWorkspaceTaskManager(
  workspacePath: string,
): Promise<void> {
  const normalized = normalizePath(workspacePath);
  const manager = taskManagerRegistry.get(normalized);
  taskManagerRegistry.delete(normalized);
  await manager?.disposeAll();
  clearWorkspaceAgentRows(normalized);
}

/**
 * Drop this workspace's rows from the (module-level, ephemeral) agent
 * collections. disposeAll only tears down live tasks; the rows outlive it.
 */
function clearWorkspaceAgentRows(normalizedWorkspacePath: string): void {
  const taskIds = new Set(
    agentTasksCollection.toArray
      .filter((task) => task.workspacePath === normalizedWorkspacePath)
      .map((task) => task.taskId),
  );
  if (taskIds.size === 0) return;

  for (const entry of agentEntriesCollection.toArray) {
    if (taskIds.has(entry.taskId)) agentEntriesCollection.delete(entry.id);
  }
  for (const turn of agentTurnsCollection.toArray) {
    if (taskIds.has(turn.taskId)) agentTurnsCollection.delete(turn.turnId);
  }
  for (const request of agentPermissionRequestsCollection.toArray) {
    if (taskIds.has(request.taskId)) {
      agentPermissionRequestsCollection.delete(request.id);
    }
  }
  for (const taskId of taskIds) agentTasksCollection.delete(taskId);
}
