import {
  newTaskId,
  newTurnId,
  newEventId,
  newInteractionId,
  BUILT_IN_HARNESSES,
  composePrompt,
  renderToolGuidance,
  type AgentTool,
  type ContentBlock,
  type HarnessDefinition,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolAgentsFacade,
  type ToolCallUpdate,
  type ToolContext,
  type TurnOutcome,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { PermissionBroker } from "./permission-broker";
import { MetristsAcpClient } from "./acp-client";
import type { AgentTransport } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import { toolRegistry, getTool } from "./tools";
import { findToolFence } from "./tool-fence";
import { checkpointWorkspaceHistory } from "@/utils/history-service";
import {
  agentEntriesCollection,
  agentInteractionsCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentTaskStatus,
  type AgentTurnStatus,
} from "./agent-collections";

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
  /** True once a `metrists:tool` fence has been dispatched this turn (at most one per reply). */
  fenceHandled: boolean;
  /** The user prompt that started this turn (checkpoint commit message). */
  userText: string;
};

function contentBlockText(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal structural `ToolAgentsFacade` (Stage 2's `ToolContext.agents`),
 * built from this module's own registries/free functions rather than
 * importing `./agents` — `agents.ts` itself imports from this file, so
 * importing it back here would be circular.
 */
function buildToolAgentsFacade(): ToolAgentsFacade {
  return {
    task: (taskId: string) => ({
      prompt: (text: string) => taskRegistry.get(taskId)?.prompt(text),
      cancel: () => cancelAgentTask(taskId),
    }),
    workspace: (workspacePath: string) => ({
      createTask: (harness: unknown) =>
        startAgentTask(workspacePath, harness as HarnessDefinition),
    }),
  };
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
   * Single-slot coalescing: the next prompt to run. Prompts arriving while a
   * turn runs overwrite it (latest wins) rather than stacking a queue — the UI
   * gates Send while running, so this only coalesces rapid programmatic sends.
   * A displaced slot resolves its handle as "superseded" (A3) before being
   * overwritten.
   */
  private pendingPrompt:
    | { turnId: string; text: string; fromContinuation: boolean }
    | null = null;
  /** Consecutive tool-triggered continuation turns (runaway-loop circuit breaker). */
  private toolContinuationDepth = 0;
  private static readonly MAX_TOOL_CONTINUATION_DEPTH = 8;
  /** Sent once per task, on the first turn only (Stage 2 tool guidance). */
  private guidanceSent = false;
  /** turnId → resolver for that turn's prompt-handle `completed` promise. */
  private readonly turnResolvers = new Map<
    string,
    (outcome: TurnOutcome) => void
  >();
  /** Tool interactions already folded into a sent continuation prompt. */
  private readonly deliveredInteractionIds = new Set<string>();
  /** True while `drainQueue`'s loop is actively running (reentrancy guard). */
  private draining = false;
  /** "How to sign in" hint, surfaced only when an auth error actually occurs. */
  private authHintValue?: string;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

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
      const session = await this.client.newSession(this.workspacePath);
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
   * Send a user prompt. While a turn runs the text is held in a single slot
   * (latest wins) and promoted when the turn ends; a displaced slot's handle
   * resolves "superseded" (A3). The UI may ignore the returned handle
   * (fire-and-forget); tests and programmatic callers await `completed`.
   */
  prompt(text: string): { turnId: string; completed: Promise<TurnOutcome> } {
    return this.enqueuePrompt(text, false);
  }

  private enqueuePrompt(
    text: string,
    fromContinuation: boolean,
  ): { turnId: string; completed: Promise<TurnOutcome> } {
    if (!this.client || !this.sessionId) {
      throw new Error("agent task is not started");
    }
    const turnId = newTurnId();

    const displaced = this.pendingPrompt;
    if (displaced) {
      this.resolveTurn(displaced.turnId, { status: "superseded" });
    }
    this.pendingPrompt = { turnId, text, fromContinuation };

    const completed = new Promise<TurnOutcome>((resolve) => {
      this.turnResolvers.set(turnId, resolve);
    });
    // A running (or actively draining, e.g. a continuation composed from
    // inside finishTurn) loop will pick this up; otherwise start one.
    if (!this.currentTurn && !this.draining) void this.drainQueue();
    return { turnId, completed };
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
      while (!this.disposed && this.pendingPrompt !== null) {
        const { turnId, text, fromContinuation } = this.pendingPrompt;
        this.pendingPrompt = null;
        // Depth cap (Stage 2): reset on any user-initiated prompt, count
        // consecutive tool-triggered continuations only.
        this.toolContinuationDepth = fromContinuation
          ? this.toolContinuationDepth + 1
          : 0;
        const status = await this.runTurn(turnId, text);
        // Don't auto-run a coalesced follow-up through the same failure (e.g.
        // an auth block); it resumes when the user sends again.
        if (status === "error") break;
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(turnId: string, text: string): Promise<AgentTurnStatus> {
    if (!this.client || !this.sessionId) {
      this.resolveTurn(turnId, { status: "error", error: "agent task is not started" });
      return "error";
    }

    const now = Date.now();

    // First prompt names the task.
    if (this.title === "New task") {
      this.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.title = this.title;
      });
    }

    // User prompt as a first-class transcript entry.
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
      sessionId: this.sessionId,
      status: "running",
      startedAt: now,
    });

    this.currentTurn = {
      turnId,
      joiner: new MarkdownJoiner(),
      text: "",
      textEntryId: null,
      fenceHandled: false,
      userText: text,
    };
    this.setStatus("running");

    try {
      const preamble = this.guidanceSent
        ? undefined
        : renderToolGuidance(toolRegistry);
      this.guidanceSent = true;
      const blocks = composePrompt({
        text,
        preamble,
        capabilities: { embeddedContext: this.client.embeddedContextCapability },
      });
      const response = await this.client.prompt(this.sessionId, blocks);
      // A turn that reached the model clears any stale auth banner.
      this.setAuthHint(undefined);
      return this.finishTurn(response.stopReason, "completed");
    } catch (error) {
      const message = errorMessage(error);
      // Logged-out claude-code-acp fails here with "Authentication required"
      // (see docs/architecture/spikes/phase1-auth-spike.md).
      if (/authentication required/i.test(message)) {
        this.setAuthHint(this.client?.authHint ?? this.harness.authHint);
        this.raiseAuthInteraction(turnId, message);
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
    this.resolveLingeringToolCalls(turn.turnId);

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
    // Now idle: fold in any tool answers that arrived mid-turn. Not on error
    // (A5: don't auto-continue through a failure) or cancel (the user just
    // stopped the task; a fresh continuation would fight that intent).
    if (turnStatus === "completed") {
      this.maybeComposeContinuation();
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
          if (!turn.fenceHandled) this.maybeDispatchToolFence(turn);
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
   * Stage 2: detect a complete `metrists:tool` fence in the accumulating
   * assistant text (the joiner already surfaces it as soon as its closing
   * ``` streams in — no need to wait for turn end). At most one fence per
   * reply (`turn.fenceHandled`); malformed fences and valid ones both route
   * through an `agentInteractions` row + `answerInteraction`, giving the
   * doc's "one repair round-trip" for free via the existing continuation
   * machinery.
   */
  private maybeDispatchToolFence(turn: TurnState): void {
    const result = findToolFence(turn.text);
    if (result.kind === "none" || result.kind === "incomplete") return;
    turn.fenceHandled = true;
    this.closeTextRun(turn);

    const toolCallId = newEventId();
    const entryId = newEventId();

    if (result.kind === "malformed") {
      agentEntriesCollection.insert({
        id: entryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: "tool_call",
        toolCallId,
        toolCallSource: "fence",
        toolCall: { toolCallId, title: "(malformed tool fence)", status: "failed" },
        createdAt: Date.now(),
      });
      this.raiseToolInteraction(
        entryId,
        `malformed tool fence: ${result.reason}`,
        `Tool error: the fence was malformed (${result.reason}). Re-emit a well-formed metrists:tool fence.`,
      );
      return;
    }

    const tool = getTool(result.name);
    if (!tool) {
      agentEntriesCollection.insert({
        id: entryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: "tool_call",
        toolCallId,
        toolCallSource: "fence",
        toolCall: { toolCallId, title: result.name, status: "failed" },
        createdAt: Date.now(),
      });
      this.raiseToolInteraction(
        entryId,
        `unknown tool: ${result.name}`,
        `Tool error: unknown tool "${result.name}". Available tools: ${toolRegistry.map((t) => t.name).join(", ")}.`,
      );
      return;
    }

    const parsedInput = tool.input.safeParse(result.input);
    if (!parsedInput.success) {
      agentEntriesCollection.insert({
        id: entryId,
        taskId: this.taskId,
        turnId: turn.turnId,
        type: "tool_call",
        toolCallId,
        toolCallSource: "fence",
        toolCall: {
          toolCallId,
          title: tool.name,
          status: "failed",
          rawInput: isPlainObject(result.input) ? result.input : undefined,
        },
        createdAt: Date.now(),
      });
      this.raiseToolInteraction(
        entryId,
        `invalid input for ${tool.name}`,
        `Tool error: invalid input for "${tool.name}": ${parsedInput.error.message}`,
      );
      return;
    }

    agentEntriesCollection.insert({
      id: entryId,
      taskId: this.taskId,
      turnId: turn.turnId,
      type: "tool_call",
      toolCallId,
      toolCallSource: "fence",
      toolCall: {
        toolCallId,
        title: tool.name,
        status: "pending",
        rawInput: isPlainObject(result.input) ? result.input : undefined,
      },
      createdAt: Date.now(),
    });

    void this.executeFenceTool(tool, entryId, parsedInput.data);
  }

  private async executeFenceTool(
    tool: AgentTool<unknown, unknown>,
    entryId: string,
    input: unknown,
  ): Promise<void> {
    if (tool.requiresPermission) {
      const response = await this.permissionBroker.request({
        sessionId: this.sessionId ?? "",
        toolCall: { toolCallId: entryId, title: tool.name },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = response.outcome;
      const denied =
        outcome.outcome === "cancelled" ||
        (outcome.outcome === "selected" && outcome.optionId === "deny");
      if (denied) {
        agentEntriesCollection.update(entryId, (draft) => {
          if (draft.toolCall) draft.toolCall.status = "failed";
        });
        this.raiseToolInteraction(
          entryId,
          `${tool.name} was denied`,
          `Tool error: permission denied for "${tool.name}".`,
        );
        return;
      }
    }

    const ctx: ToolContext = {
      workspacePath: this.workspacePath,
      taskId: this.taskId,
      agents: buildToolAgentsFacade(),
    };
    const result = await tool.execute(ctx, input);
    agentEntriesCollection.update(entryId, (draft) => {
      if (draft.toolCall) draft.toolCall.status = result.ok ? "completed" : "failed";
    });
    const resultText = result.ok
      ? `Tool result: ${JSON.stringify(result.value)}`
      : `Tool error: ${result.error}`;
    this.raiseToolInteraction(entryId, tool.name, resultText);
  }

  /** Insert a `source: "tool"` interaction and immediately answer it with the
   *  execution result — the app is the "answerer" here, not the user; this
   *  is what feeds Stage 1's continuation batching. */
  private raiseToolInteraction(
    entryId: string,
    question: string,
    resultText: string,
  ): void {
    const interactionId = newInteractionId();
    agentInteractionsCollection.insert({
      id: interactionId,
      taskId: this.taskId,
      entryId,
      source: "tool",
      state: "pending",
      question,
      createdAt: Date.now(),
    });
    this.answerInteraction(interactionId, resultText);
  }

  /**
   * Coalesce a tool call into one entry keyed by toolCallId: the first tool_call
   * inserts, later updates (pending → in_progress → completed/failed) merge into
   * the same entry so the UI shows one transitioning card, not a stack. Keyed at
   * the task level so updates land even after the turn that started them ends.
   * Tool entries are first-class — not nested under a message.
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
        // ACP updates replace each field, so a shallow merge is correct.
        draft.toolCall = {
          ...(draft.toolCall as ToolCallUpdate),
          ...update,
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
      toolCall: update,
      createdAt: Date.now(),
    });
  }

  /** Flip this turn's still-open tool calls to completed (turn is over). */
  private resolveLingeringToolCalls(turnId: string): void {
    for (const entry of agentEntriesCollection.toArray) {
      if (entry.type !== "tool_call" || entry.turnId !== turnId) continue;
      const status = entry.toolCall?.status;
      if (status === "pending" || status === "in_progress" || status == null) {
        agentEntriesCollection.update(entry.id, (draft) => {
          if (draft.toolCall) draft.toolCall.status = "completed";
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
   * Other tasks are untouched.
   */
  async cancel(): Promise<void> {
    this.permissionBroker.cancelAll();
    this.cancelPendingInteractions();
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

  /**
   * Answer an interaction this task raised (tool ask, auth block). Tool
   * answers accumulate and compose into exactly one continuation prompt once
   * the task is idle (`maybeComposeContinuation`, deferred a tick here,
   * called again from `finishTurn`). Auth interactions are answered by
   * Stage 4's `authenticate` retry flow, not a continuation — excluded here.
   * Blobs (question/approval widgets) never raise an interaction row at all
   * — see `answerBlob` in blob-actions.ts, which prompts the authoring task
   * directly instead of going through this state machine.
   */
  answerInteraction(interactionId: string, answer: string): void {
    const row = agentInteractionsCollection.get(interactionId);
    if (!row || row.taskId !== this.taskId || row.state !== "pending") return;
    agentInteractionsCollection.update(interactionId, (draft) => {
      draft.state = "answered";
      draft.answer = answer;
    });
    // Deferred a tick so answers landing in the same synchronous batch (e.g.
    // several widgets answered back to back) fold into one continuation
    // instead of each triggering its own turn.
    if (row.source === "tool") {
      queueMicrotask(() => this.maybeComposeContinuation());
    }
  }

  /** Cancel a specific pending interaction (e.g. the user dismisses a question). */
  cancelInteraction(interactionId: string): void {
    const row = agentInteractionsCollection.get(interactionId);
    if (!row || row.taskId !== this.taskId || row.state !== "pending") return;
    agentInteractionsCollection.update(interactionId, (draft) => {
      draft.state = "cancelled";
    });
  }

  private cancelPendingInteractions(): void {
    for (const row of agentInteractionsCollection.toArray) {
      if (row.taskId === this.taskId && row.state === "pending") {
        agentInteractionsCollection.update(row.id, (draft) => {
          draft.state = "cancelled";
        });
      }
    }
  }

  /**
   * Mint one continuation prompt covering every tool interaction answered
   * since the last continuation, once the task is idle. No-op mid-turn —
   * the caller re-checks when the turn ends (`finishTurn`).
   */
  private maybeComposeContinuation(): void {
    if (this.currentTurn) return;
    const answered = agentInteractionsCollection.toArray.filter(
      (row) =>
        row.taskId === this.taskId &&
        row.source === "tool" &&
        row.state === "answered" &&
        !this.deliveredInteractionIds.has(row.id),
    );
    if (answered.length === 0) return;

    if (this.toolContinuationDepth >= AgentTask.MAX_TOOL_CONTINUATION_DEPTH) {
      // Runaway-loop circuit breaker: stop auto-composing past the depth
      // cap and surface a visible, still-pending interaction instead.
      this.warn(
        "tool continuation depth cap reached",
        this.toolContinuationDepth,
      );
      agentInteractionsCollection.insert({
        id: newInteractionId(),
        taskId: this.taskId,
        entryId: answered[0].entryId,
        source: "tool",
        state: "pending",
        question:
          "The agent is iterating on tool calls — continue letting it proceed?",
        createdAt: Date.now(),
      });
      return;
    }

    for (const row of answered) this.deliveredInteractionIds.add(row.id);
    const text = answered
      .map((row) => `Answer to "${row.question}": ${row.answer}`)
      .join("\n");
    this.enqueuePrompt(text, true);
  }

  /** Raise a structured `auth` interaction alongside the string authHint banner (A5). */
  private raiseAuthInteraction(turnId: string, message: string): void {
    const entryId = newEventId();
    agentEntriesCollection.insert({
      id: entryId,
      taskId: this.taskId,
      turnId,
      type: "unknown",
      text: "auth_error",
      raw: { message },
      createdAt: Date.now(),
    });
    agentInteractionsCollection.insert({
      id: newInteractionId(),
      taskId: this.taskId,
      entryId,
      source: "auth",
      state: "pending",
      question: message,
      createdAt: Date.now(),
    });
  }

  get authHint(): string | undefined {
    return this.authHintValue;
  }

  get currentStatus(): AgentTaskStatus {
    return this.status;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pendingPrompt) {
      this.resolveTurn(this.pendingPrompt.turnId, { status: "cancelled" });
      this.pendingPrompt = null;
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    await this.cancel();
    await this.transport?.close();
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
    taskRegistry.set(taskId, task);
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
    taskRegistry.delete(taskId);
    await task?.dispose();
  }

  async disposeAll(): Promise<void> {
    const tasks = this.listTasks();
    this.tasks.clear();
    for (const task of tasks) taskRegistry.delete(task.taskId);
    await Promise.all(tasks.map((task) => task.dispose()));
  }
}

/** Flat taskId → AgentTask registry (editor-store convention) backing the
 *  free-function command API below, so the app addresses tasks by id alone. */
const taskRegistry = new Map<string, AgentTask>();
const taskManagerRegistry = new Map<string, TaskManager>();

/** Exposed so `agents.ts`'s entity-handle facade can resolve a live task. */
export function getRegisteredTask(taskId: string): AgentTask | undefined {
  return taskRegistry.get(taskId);
}

/**
 * Which task authored a given blob, and its type/path — read straight off
 * the `author_blob` tool call's transcript entry (every fence tool call
 * already gets one, with `rawInput` verbatim), rather than a dedicated
 * blob-tracking table. Used by `answerBlob` (blob-actions.ts) to address a
 * fresh prompt back at the right session once the user interacts with the
 * blob; the answer never routes through `agentInteractions`.
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

/** Send a prompt to a task (fire-and-forget; single-slot coalescing). */
export function promptAgentTask(taskId: string, text: string): void {
  taskRegistry.get(taskId)?.prompt(text);
}

/** Cancel a task's running turn and pending permissions. */
export async function cancelAgentTask(taskId: string): Promise<void> {
  await taskRegistry.get(taskId)?.cancel();
}

/** Answer a pending permission request (rows flow via the collection). */
export function respondToAgentPermission(
  taskId: string,
  requestId: string,
  response: RequestPermissionResponse,
): void {
  taskRegistry.get(taskId)?.respondPermission(requestId, response);
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
  for (const interaction of agentInteractionsCollection.toArray) {
    if (taskIds.has(interaction.taskId)) {
      agentInteractionsCollection.delete(interaction.id);
    }
  }
  for (const taskId of taskIds) agentTasksCollection.delete(taskId);
}
