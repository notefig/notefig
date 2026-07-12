import {
  newTaskId,
  newTurnId,
  newEventId,
  BUILT_IN_HARNESSES,
  composePrompt,
  MCP_SERVER_NAME,
  type ContentBlock,
  type HarnessDefinition,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
  type TurnOutcome,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { PermissionBroker } from "./permission-broker";
import { MetristsAcpClient } from "./acp-client";
import type { AgentTransport } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import {
  attachMcpTransport,
  createMcpRequestHandler,
  renderToolUsagePreamble,
} from "./mcp-server";
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

/** In-flight turn bookkeeping (assistant-text coalescing into one entry). */
type TurnState = {
  turnId: string;
  /** Re-chunks streamed markdown at safe render boundaries. */
  joiner: MarkdownJoiner;
  /** Text accumulated into the current assistant run (reset after a tool call). */
  text: string;
  /** The assistant entry the current run is streaming into, or null to open one. */
  textEntryId: string | null;
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
 * file-presence affordances (Stage 3) the same as native ones.
 */
function deriveToolLocations(rawInput: unknown): Array<{ path: string }> | undefined {
  if (!isPlainObject(rawInput) || typeof rawInput.path !== "string") return undefined;
  return [{ path: rawInput.path }];
}

/**
 * Adapters mint MCP tool names as `mcp__<serverName>__<toolName>` (confirmed
 * on claude-agent-acp — docs/architecture/spikes/v2-mcp-passthrough-spike.md).
 * Strip the prefix so transcript entries and `findBlobAuthorTask` see the
 * plain tool name, same as any other tool call.
 */
function normalizeMcpToolName(title: string | null | undefined): string | undefined {
  if (!title) return undefined;
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
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
  private readonly pendingPrompts: { turnId: string; text: string }[] = [];
  /** turnId → resolver for that turn's prompt-handle `completed` promise. */
  private readonly turnResolvers = new Map<
    string,
    (outcome: TurnOutcome) => void
  >();
  /** True while `drainQueue`'s loop is actively running (reentrancy guard). */
  private draining = false;
  /** "How to sign in" hint, surfaced only when an auth error actually occurs. */
  private authHintValue?: string;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];
  /** Stage 3.5: this task's app-tools MCP transport; torn down in dispose(). */
  private mcpTransport: AgentTransport | null = null;
  /** Sent once per task, on the first turn only (steers tool preference). */
  private toolUsagePreambleSent = false;

  constructor(
    readonly taskId: string,
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
    /** Set when spawned by another task (subagent pattern, opencode-style) */
    readonly parentTaskId?: string,
  ) {
    this.permissionBroker = new PermissionBroker(taskId);
  }

  /** Spawn transport + connect ACP + create the session. */
  async start(transport: AgentTransport): Promise<void> {
    this.transport = transport;
    this.insertTaskRow();

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

    // Bring the transport live before any ACP traffic; spawn failure surfaces
    // here as an AgentTransportError and marks the task errored.
    try {
      await transport.start();
      await this.client.connect();
      // Note: we do NOT surface authHint here — the adapter always advertises
      // authMethods regardless of login (see the auth spike), so the hint only
      // becomes meaningful when a prompt actually fails with "auth required".
      // Same construct-then-start pattern as the ACP transport above:
      // createMcpTransport is a dumb sync constructor, we call start()
      // ourselves, and mcpServer only exists on the instance afterward.
      const mcpTransport = platformAdapter.createMcpTransport({ taskId: this.taskId });
      this.mcpTransport = mcpTransport;
      await mcpTransport.start();
      this.unsubscribers.push(
        attachMcpTransport(
          mcpTransport,
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
      const session = await this.client.newSession(
        this.workspacePath,
        mcpTransport.mcpServer ? [mcpTransport.mcpServer] : [],
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
   * Send a user prompt. Enqueue always succeeds — this never throws. While a
   * turn runs the prompt queues FIFO, visible in the transcript as a
   * `"queued"` turn row; a task that never started or is disposed resolves
   * the handle as an error/cancelled value instead. The UI may ignore the
   * returned handle (fire-and-forget is lossless); tests and programmatic
   * callers await `completed`.
   */
  prompt(text: string): { turnId: string; completed: Promise<TurnOutcome> } {
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

    this.pendingPrompts.push({ turnId, text });
    // A running (or actively draining) loop will pick this up; otherwise start one.
    if (!this.currentTurn && !this.draining) void this.drainQueue();
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
        const { turnId, text } = this.pendingPrompts.shift()!;
        const status = await this.runTurn(turnId, text);
        // Don't march the rest of the queue through the same failure (e.g.
        // an auth block); remaining rows stay visibly queued and resume on
        // the next successful send.
        if (status === "error") break;
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(turnId: string, text: string): Promise<AgentTurnStatus> {
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
      text: "",
      textEntryId: null,
      userText: text,
    };
    this.setStatus("running");

    try {
      const preamble = this.toolUsagePreambleSent
        ? undefined
        : renderToolUsagePreamble();
      const blocks = composePrompt({
        text,
        preamble,
        capabilities: { embeddedContext: this.client.embeddedContextCapability },
      });
      const response = await this.client.prompt(this.sessionId, blocks);
      // Only after a successful round-trip — a failed first turn (auth block,
      // dead transport) must not eat the preamble for the retry.
      this.toolUsagePreambleSent = true;
      // A turn that reached the model clears any stale auth banner.
      this.setAuthHint(undefined);
      return this.finishTurn(response.stopReason, "completed");
    } catch (error) {
      const message = errorMessage(error);
      // Logged-out claude-code-acp fails here with "Authentication required"
      // (see docs/architecture/spikes/phase1-auth-spike.md). The string
      // authHint banner (set below) is the sole signal for now — the richer
      // task-row auth state (methods, retry) is Stage 4's job.
      if (/authentication required/i.test(message)) {
        this.setAuthHint(this.client?.authHint ?? this.harness.authHint);
      }
      this.warn("turn error", message);
      return this.finishTurn(undefined, "error", message);
    }
  }

  private finishTurn(
    stopReason: string | undefined,
    turnStatus: AgentTurnStatus,
    error?: string,
  ): AgentTurnStatus {
    const turn = this.currentTurn;
    if (!turn) return turnStatus;

    const tail = turn.joiner.flush();
    if (tail) {
      turn.text += tail;
      this.writeAssistantText(turn);
    }

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
        const flushable = turn.joiner.processText(contentBlockText(update.content));
        if (flushable) {
          turn.text += flushable;
          this.writeAssistantText(turn);
        }
        break;
      }
      case "plan": {
        // Plans are peers of text/tools; close the current text run so a
        // following reply opens a fresh assistant entry after the plan.
        this.closeTextRun(turn);
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
        // D4: agent_thought_chunk / user_message_chunk /
        // available_commands_update / current_mode_update — not rendered
        // yet, but kept as transcript data rather than dropped. Text-run
        // boundaries are left alone (no closeTextRun) since thought chunks
        // often interleave with message chunks.
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
            update.locations ?? deriveToolLocations(update.rawInput) ?? previous?.locations,
        };
      });
      return;
    }

    // A new tool call ends the current assistant text run, so the reply that
    // follows the tool renders below it (correct interleaving).
    if (this.currentTurn) this.closeTextRun(this.currentTurn);
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
        locations: update.locations ?? deriveToolLocations(update.rawInput),
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

  private setAuthHint(hint?: string): void {
    this.authHintValue = hint;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.authHint = hint;
      });
    }
  }

  /**
   * End the current assistant text run; the next chunk opens a fresh entry.
   * Flush the joiner first so text it was still buffering (awaiting a safe
   * markdown boundary) lands in this run instead of being dropped when a tool
   * call interrupts.
   */
  private closeTextRun(turn: TurnState): void {
    const tail = turn.joiner.flush();
    if (tail) {
      turn.text += tail;
      this.writeAssistantText(turn);
    }
    turn.textEntryId = null;
    turn.text = "";
  }

  /** Upsert the current assistant text run into its single coalesced entry. */
  private writeAssistantText(turn: TurnState): void {
    if (!turn.textEntryId) {
      turn.textEntryId = newEventId();
      agentEntriesCollection.insert({
        id: turn.textEntryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: "assistant",
        text: turn.text,
        createdAt: Date.now(),
      });
    } else {
      agentEntriesCollection.update(turn.textEntryId, (draft) => {
        draft.text = turn.text;
      });
    }
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
    await Promise.all([this.transport?.close(), this.mcpTransport?.close()]);
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
  const transport = platformAdapter.createAgentTransport({
    taskId: task.taskId,
    harness,
    workspacePath,
  });
  await task.start(transport);
  return task.taskId;
}

/** Send a prompt to a task (fire-and-forget; FIFO queue, lossless). */
export function promptAgentTask(taskId: string, text: string): void {
  getRegisteredTask(taskId)?.prompt(text);
}

/** Remove one queued (not yet running) prompt from a task's queue. */
export function removeQueuedPrompt(taskId: string, turnId: string): void {
  getRegisteredTask(taskId)?.removeQueuedPrompt(turnId);
}

/** Cancel a task's running turn and pending permissions. */
export async function cancelAgentTask(taskId: string): Promise<void> {
  await getRegisteredTask(taskId)?.cancel();
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
