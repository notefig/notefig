import {
  newTaskId,
  newTurnId,
  newMessageId,
  newEventId,
  newDiagnosticId,
  type ContentBlock,
  type HarnessDefinition,
  type SessionNotification,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { AgentWriteGate } from "./agent-write-gate";
import { PermissionBroker } from "./permission-broker";
import { MetristsAcpClient } from "./acp-client";
import { tapTransport } from "./agent-transport.interface";
import type { AgentTransport } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import { AgentTracer, isAgentTracingEnabled } from "./agent-trace";
import {
  agentDiagnosticsCollection,
  agentEventsCollection,
  agentMessagesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentDiagnosticKind,
  type AgentDiagnosticRow,
  type AgentTaskStatus,
  type AgentTurnStatus,
} from "./agent-collections";

/** KV namespace for agent state (sessionId per task, workspace trust flag). */
const AGENT_KV_NAMESPACE = "agent";

/** In-flight turn bookkeeping (chunk coalescing + client-minted ids). */
type TurnState = {
  turnId: string;
  /** Minted when the first assistant update arrives (ACP chunks are anonymous). */
  assistantMessageId: string | null;
  /** Re-chunks streamed markdown at safe render boundaries. */
  joiner: MarkdownJoiner;
  /** Coalesced assistant text so far. */
  text: string;
  /** The single message_chunk event row we keep updating for this message. */
  chunkEventId: string | null;
  /** toolCallId → event row id, so updates coalesce into one card. */
  toolEventIds: Map<string, string>;
};

/** Queued prompt + the deferred that resolves when its own turn ends. */
type QueuedPrompt = { text: string; resolve: () => void };

function contentBlockText(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
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
 */
export class AgentTask {
  readonly permissionBroker = new PermissionBroker();

  private client: MetristsAcpClient | null = null;
  private transport: AgentTransport | null = null;
  private sessionId: string | null = null;
  private status: AgentTaskStatus = "starting";
  private title = "New task";

  private currentTurn: TurnState | null = null;
  /** Prompts arriving while a turn runs: FIFO, promoted on turn end. */
  private readonly promptQueue: QueuedPrompt[] = [];
  /** "How to sign in" hint, surfaced only when an auth error actually occurs. */
  private authHintValue?: string;
  private disposed = false;
  /** Opt-in on-disk trace of the diagnostics stream (dev flag). */
  private tracer?: AgentTracer;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    readonly taskId: string,
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
    private readonly writeGate: AgentWriteGate,
    /** Set when spawned by another task (subagent pattern, opencode-style) */
    readonly parentTaskId?: string,
  ) {}

  /** Spawn transport + connect ACP + create the session. */
  async start(transport: AgentTransport): Promise<void> {
    if (isAgentTracingEnabled()) {
      this.tracer = new AgentTracer(this.workspacePath, this.taskId);
    }
    // Tap frames both directions into the diagnostics stream, then use the
    // wrapper everywhere (it delegates all lifecycle to the inner transport).
    const tapped = tapTransport(transport, {
      onOutgoing: (line) => this.logDiagnostic("frame_out", line),
      onIncoming: (line) => this.logDiagnostic("frame_in", line),
    });
    this.transport = tapped;
    this.insertTaskRow();

    this.unsubscribers.push(
      tapped.onClose((error) => this.handleTransportClose(error)),
    );
    // Adapter stderr → diagnostics (was console.debug-only, D1).
    if (tapped.onDiagnostic) {
      this.unsubscribers.push(
        tapped.onDiagnostic((line) => this.logDiagnostic("stderr", line)),
      );
    }

    this.client = new MetristsAcpClient({
      taskId: this.taskId,
      transport: tapped,
      permissionBroker: this.permissionBroker,
      writeGate: this.writeGate,
      onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
    });

    // Bring the transport live before any ACP traffic; spawn failure surfaces
    // here as an AgentTransportError and marks the task errored.
    try {
      await tapped.start();
      if (tapped.spawnInfo) this.logDiagnostic("spawn_context", tapped.spawnInfo);
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
      this.logDiagnostic("turn_error", { phase: "start", message });
      this.setStatus("error");
      throw error instanceof AgentTransportError ? error : new Error(message);
    }
  }

  /**
   * Send a user prompt. The returned promise resolves when *this* prompt's
   * turn reaches a terminal state (completed / error / cancelled) — not merely
   * when it is accepted. Prompts sent while a turn runs are queued FIFO.
   */
  async prompt(text: string): Promise<void> {
    if (!this.client || !this.sessionId) {
      throw new Error("agent task is not started");
    }
    return new Promise<void>((resolve) => {
      this.promptQueue.push({ text, resolve });
      // A running turn's drain loop will pick this up; otherwise start one.
      if (!this.currentTurn) void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    while (!this.disposed && this.promptQueue.length > 0) {
      const item = this.promptQueue.shift() as QueuedPrompt;
      const status = await this.runTurn(item.text);
      item.resolve();
      // A5: don't spam the rest of the queue through the same failure (e.g.
      // three "Authentication required" turns). Remaining prompts stay queued
      // and resume on the next prompt() once the block is resolved.
      if (status === "error") break;
    }
  }

  private async runTurn(text: string): Promise<AgentTurnStatus> {
    if (!this.client || !this.sessionId) return "error";

    const turnId = newTurnId();
    const userMessageId = newMessageId();
    const now = Date.now();

    // First prompt names the task.
    if (this.title === "New task") {
      this.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.title = this.title;
      });
    }

    // User message + its text as a message_chunk event (messages are the
    // addressable unit; content lives in events).
    agentMessagesCollection.insert({
      messageId: userMessageId,
      taskId: this.taskId,
      turnId,
      role: "user",
      createdAt: now,
    });
    agentEventsCollection.insert({
      id: newEventId(),
      messageId: userMessageId,
      turnId,
      taskId: this.taskId,
      kind: "message_chunk",
      payload: { text },
      receivedAt: now,
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
      assistantMessageId: null,
      joiner: new MarkdownJoiner(),
      text: "",
      chunkEventId: null,
      toolEventIds: new Map(),
    };
    this.setStatus("running");

    try {
      const response = await this.client.prompt(this.sessionId, [
        { type: "text", text },
      ]);
      // A turn that reached the model clears any stale auth banner.
      this.setAuthHint(undefined);
      return this.finishTurn(response.stopReason, "completed");
    } catch (error) {
      const message = errorMessage(error);
      // Logged-out claude-code-acp fails here with "Authentication required"
      // (see docs/architecture/spikes/phase1-auth-spike.md).
      if (/authentication required/i.test(message)) {
        this.setAuthHint(this.client?.authHint ?? this.harness.authHint);
      }
      this.logDiagnostic("turn_error", { turnId, message });
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
      this.writeAssistantChunk(turn);
    }

    agentTurnsCollection.update(turn.turnId, (draft) => {
      draft.status = turnStatus;
      draft.stopReason = stopReason;
      if (error) draft.error = error;
    });

    this.currentTurn = null;
    this.setStatus(turnStatus === "error" ? "error" : "idle");
    void this.tracer?.flush(); // persist at turn boundaries (dev flag)
    return turnStatus;
  }

  handleSessionUpdate(notification: SessionNotification): void {
    const turn = this.currentTurn;
    if (!turn) {
      // Update outside a turn — keep it in diagnostics rather than dropping it.
      this.logDiagnostic("session_update", notification.update);
      return;
    }
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const flushable = turn.joiner.processText(contentBlockText(update.content));
        if (flushable) {
          turn.text += flushable;
          this.writeAssistantChunk(turn);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.upsertToolEvent(turn, update);
        break;
      }
      case "plan": {
        const messageId = this.ensureAssistantMessage(turn);
        agentEventsCollection.insert({
          id: newEventId(),
          messageId,
          turnId: turn.turnId,
          taskId: this.taskId,
          kind: "plan",
          payload: update,
          receivedAt: Date.now(),
        });
        break;
      }
      default:
        // agent_thought_chunk / user_message_chunk / available_commands_update
        // / current_mode_update — not rendered, but recorded for debugging (D4).
        this.logDiagnostic("session_update", update);
        break;
    }
  }

  /**
   * Coalesce a tool call into one row keyed by toolCallId: the first update
   * inserts, later ones (pending → in_progress → completed) merge into the
   * same event so the UI shows one transitioning card, not a stack.
   */
  private upsertToolEvent(
    turn: TurnState,
    update: Extract<
      SessionNotification["update"],
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >,
  ): void {
    const toolCallId = update.toolCallId;
    const existingId = toolCallId
      ? turn.toolEventIds.get(toolCallId)
      : undefined;

    if (existingId) {
      agentEventsCollection.update(existingId, (draft) => {
        draft.kind = update.sessionUpdate;
        draft.payload = {
          ...(draft.payload as Record<string, unknown>),
          ...update,
        };
      });
      return;
    }

    const messageId = this.ensureAssistantMessage(turn);
    const eventId = newEventId();
    if (toolCallId) turn.toolEventIds.set(toolCallId, eventId);
    agentEventsCollection.insert({
      id: eventId,
      messageId,
      turnId: turn.turnId,
      taskId: this.taskId,
      kind: update.sessionUpdate,
      payload: update,
      receivedAt: Date.now(),
    });
  }

  private logDiagnostic(kind: AgentDiagnosticKind, payload: unknown): void {
    const row: AgentDiagnosticRow = {
      id: newDiagnosticId(),
      taskId: this.taskId,
      kind,
      payload,
      receivedAt: Date.now(),
    };
    agentDiagnosticsCollection.insert(row);
    this.tracer?.append(row);
  }

  private setAuthHint(hint?: string): void {
    this.authHintValue = hint;
    if (agentTasksCollection.get(this.taskId)) {
      agentTasksCollection.update(this.taskId, (draft) => {
        draft.authHint = hint;
      });
    }
  }

  /** Ensure the assistant message row exists (chunks are anonymous in ACP). */
  private ensureAssistantMessage(turn: TurnState): string {
    if (!turn.assistantMessageId) {
      turn.assistantMessageId = newMessageId();
      agentMessagesCollection.insert({
        messageId: turn.assistantMessageId,
        taskId: this.taskId,
        turnId: turn.turnId,
        role: "assistant",
        createdAt: Date.now(),
      });
    }
    return turn.assistantMessageId;
  }

  /** Upsert the single coalesced message_chunk event for the assistant reply. */
  private writeAssistantChunk(turn: TurnState): void {
    const messageId = this.ensureAssistantMessage(turn);
    if (!turn.chunkEventId) {
      turn.chunkEventId = newEventId();
      agentEventsCollection.insert({
        id: turn.chunkEventId,
        messageId,
        turnId: turn.turnId,
        taskId: this.taskId,
        kind: "message_chunk",
        payload: { text: turn.text },
        receivedAt: Date.now(),
      });
    } else {
      agentEventsCollection.update(turn.chunkEventId, (draft) => {
        draft.payload = { text: turn.text };
      });
    }
  }

  /**
   * session/cancel + resolve this task's pending permissions as cancelled.
   * Other tasks are untouched.
   */
  async cancel(): Promise<void> {
    this.permissionBroker.cancelAll();
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

  /** Called by blob widgets when the user answers a blob this task authored. */
  notifyBlobAnswered(_blobRef: { filePath: string; blobId: string }): void {
    // TODO(phase 2): queue; when this task is idle, auto-compose a
    // continuation prompt containing the queued answers.
  }

  get authHint(): string | undefined {
    return this.authHintValue;
  }

  get currentStatus(): AgentTaskStatus {
    return this.status;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Settle any awaited-but-never-run queued prompts so callers don't hang.
    for (const item of this.promptQueue) item.resolve();
    this.promptQueue.length = 0;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    await this.cancel();
    await this.transport?.close();
    await this.tracer?.flush();
  }

  // ===== internal helpers =====

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
    this.logDiagnostic("exit", { message: error?.message ?? "transport closed" });
    if (this.currentTurn) {
      this.finishTurn(undefined, "error", error?.message ?? "agent process ended");
    } else if (!this.disposed) {
      this.setStatus("error");
    }
    void this.tracer?.flush();
  }
}

/**
 * Per-workspace task registry (registry convention: git-service-store.ts).
 * Owns the shared AgentWriteGate (per-file serialization + task attribution
 * across ALL tasks in the workspace) and workspace-level policy: trust
 * confirmation before the first spawn, harness config from settings — never
 * from document content.
 */
export class TaskManager {
  readonly writeGate = new AgentWriteGate(platformAdapter);
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
      this.writeGate,
      options?.parentTaskId,
    );
    this.tasks.set(taskId, task);
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
    await task?.dispose();
  }

  async disposeAll(): Promise<void> {
    const tasks = this.listTasks();
    this.tasks.clear();
    await Promise.all(tasks.map((task) => task.dispose()));
  }
}

const taskManagerRegistry = new Map<string, TaskManager>();

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

  for (const diagnostic of agentDiagnosticsCollection.toArray) {
    if (taskIds.has(diagnostic.taskId)) {
      agentDiagnosticsCollection.delete(diagnostic.id);
    }
  }
  for (const event of agentEventsCollection.toArray) {
    if (taskIds.has(event.taskId)) agentEventsCollection.delete(event.id);
  }
  for (const message of agentMessagesCollection.toArray) {
    if (taskIds.has(message.taskId)) {
      agentMessagesCollection.delete(message.messageId);
    }
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
