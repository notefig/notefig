import {
  newTaskId,
  type HarnessDefinition,
  type SessionNotification,
} from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { AgentWriteGate } from "./agent-write-gate";
import { PermissionBroker } from "./permission-broker";
import type { AgentTransport } from "./agent-transport.interface";

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

  constructor(
    readonly taskId: string,
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
    private readonly writeGate: AgentWriteGate,
    /** Set when spawned by another task (subagent pattern, opencode-style) */
    readonly parentTaskId?: string,
  ) {}

  /** Spawn transport + connect ACP + create or load the session. */
  async start(_transport: AgentTransport): Promise<void> {
    // TODO(phase 1): MetristsAcpClient.connect() with capabilities from the
    // transport locus, session/new with cwd = workspacePath, persist
    // sessionId in KV ("agent" namespace, keyed by taskId); session/load in
    // phase 4 when the agent advertises loadSession.
    throw new Error("not implemented: AgentTask.start");
  }

  /** Send a user prompt; streams session/update into the task-keyed collections. */
  async prompt(_text: string): Promise<void> {
    // TODO(phase 1). Also where blobs this task authored and the user has
    // answered are injected as a structured preamble ContentBlock.
    throw new Error("not implemented: AgentTask.prompt");
  }

  /**
   * session/cancel + resolve this task's pending permissions as cancelled.
   * Other tasks are untouched.
   */
  async cancel(): Promise<void> {
    this.permissionBroker.cancelAll();
    // TODO(phase 1): send session/cancel notification.
  }

  /** Called by blob widgets when the user answers a blob this task authored. */
  notifyBlobAnswered(_blobRef: { filePath: string; blobId: string }): void {
    // TODO(phase 2): queue; when this task is idle, auto-compose a
    // continuation prompt containing the queued answers.
  }

  handleSessionUpdate(_notification: SessionNotification): void {
    // TODO(phase 1): fan out into agentTurns/agentEvents (rows carry this
    // taskId), coalescing message chunks via markdown-joiner-transform.
  }

  async dispose(): Promise<void> {
    await this.cancel();
    // TODO(phase 1): close transport (kills the process).
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
}
