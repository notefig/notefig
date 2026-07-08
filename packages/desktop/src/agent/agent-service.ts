import {
  newTaskId,
  newTurnId,
  newEventId,
  BUILT_IN_HARNESSES,
  type ContentBlock,
  type HarnessDefinition,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { MarkdownJoiner } from "@/lib/markdown-joiner-transform";
import { AgentWriteGate } from "./agent-write-gate";
import { PermissionBroker } from "./permission-broker";
import { MetristsAcpClient } from "./acp-client";
import type { AgentTransport } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import { TauriStdioTransport } from "./tauri-stdio-transport";
import {
  agentEntriesCollection,
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
};

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
   */
  private pendingPrompt: string | null = null;
  /** "How to sign in" hint, surfaced only when an auth error actually occurs. */
  private authHintValue?: string;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    readonly taskId: string,
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
    private readonly writeGate: AgentWriteGate,
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
      writeGate: this.writeGate,
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
   * Send a user prompt (fire-and-forget). While a turn runs the text is held
   * in a single slot (latest wins) and promoted when the turn ends.
   */
  prompt(text: string): void {
    if (!this.client || !this.sessionId) {
      throw new Error("agent task is not started");
    }
    this.pendingPrompt = text;
    // A running turn's drain loop will pick this up; otherwise start one.
    if (!this.currentTurn) void this.drainQueue();
  }

  /** Answer a pending permission request this task raised. */
  respondPermission(requestId: string, response: RequestPermissionResponse): void {
    this.permissionBroker.respond(requestId, response);
  }

  private async drainQueue(): Promise<void> {
    while (!this.disposed && this.pendingPrompt !== null) {
      const text = this.pendingPrompt;
      this.pendingPrompt = null;
      const status = await this.runTurn(text);
      // Don't auto-run a coalesced follow-up through the same failure (e.g. an
      // auth block); it resumes when the user sends again.
      if (status === "error") break;
    }
  }

  private async runTurn(text: string): Promise<AgentTurnStatus> {
    if (!this.client || !this.sessionId) return "error";

    const turnId = newTurnId();
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

    this.currentTurn = null;
    this.setStatus(turnStatus === "error" ? "error" : "idle");
    return turnStatus;
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
        // agent_thought_chunk / user_message_chunk / available_commands_update
        // / current_mode_update — not rendered.
        break;
    }
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
    this.pendingPrompt = null;
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
  const transport = new TauriStdioTransport({
    procId: task.taskId,
    program: harness.command,
    args: harness.args,
    cwd: workspacePath,
    env: harness.env,
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

/** Files two or more of a workspace's tasks are concurrently editing. */
export function getWorkspaceOverlaps(workspacePath: string) {
  return getWorkspaceTaskManager(workspacePath)?.writeGate.getOverlappingPaths() ?? [];
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
