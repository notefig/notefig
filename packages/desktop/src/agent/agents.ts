/**
 * Entity handles for agent state — the one way the app touches tasks, turns,
 * and interactions, mirroring `editor-store.ts`'s `getOrCreateEditor(path)`
 * shape. Handles carry actions + identity; reads keep flowing through the
 * collections/`useLiveQuery` (handles are not a second state cache).
 *
 * The underlying free functions (`startAgentTask`, `cancelAgentTask`, …) in
 * `agent-service.ts` are the implementation — this module reorganizes access
 * to them, it does not duplicate their logic.
 */
import {
  newTurnId,
  type HarnessDefinition,
  type RequestPermissionResponse,
  type TurnOutcome,
} from "@metrists/shared/agent";
import { agentTurnsCollection, type AgentTurn } from "./agent-collections";
import { getRegisteredTask } from "./task-registry";
// Deferred-use import (see agent-service.ts's matching note): only
// `workspaceHandle.createTask` reaches back into the service, at call time.
import { startAgentTask } from "./agent-service";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type PromptHandle = { turnId: string; completed: Promise<TurnOutcome> };

export interface AgentTaskHandle {
  readonly taskId: string;
  /**
   * Enqueue a prompt — infallible, never throws. A missing/disposed task
   * returns a handle whose `completed` is already resolved as an error.
   */
  prompt(text: string): PromptHandle;
  cancel(): Promise<ActionResult>;
  respondPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): ActionResult;
  /**
   * ACP `authenticate` with one of the task row's `authMethods`, retrying
   * the held prompt on success. Out-of-band methods (terminal logins)
   * reject — the caller falls back to showing instructions.
   */
  authenticate(methodId: string): Promise<ActionResult>;
  /** "I've signed in" — clear the auth block and retry the held prompt. */
  retryAfterAuth(): ActionResult;
}

export interface AgentTurnHandle {
  readonly turnId: string;
  /** Current row, or undefined if the turn/task has been disposed and its
   *  rows cleared. */
  get(): AgentTurn | undefined;
}

export interface AgentWorkspaceHandle {
  readonly workspacePath: string;
  createTask(harness: HarnessDefinition): Promise<AgentTaskHandle>;
}

function taskHandle(taskId: string): AgentTaskHandle {
  return {
    taskId,
    prompt(text) {
      const task = getRegisteredTask(taskId);
      if (!task) {
        return {
          turnId: newTurnId(),
          completed: Promise.resolve<TurnOutcome>({
            status: "error",
            error: "agent task is not started",
          }),
        };
      }
      return task.prompt(text);
    },
    async cancel() {
      const task = getRegisteredTask(taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      await task.cancel();
      return { ok: true };
    },
    respondPermission(requestId, response) {
      const task = getRegisteredTask(taskId);
      if (!task) {
        return { ok: false, error: "agent task is not started" };
      }
      task.respondPermission(requestId, response);
      return { ok: true };
    },
    async authenticate(methodId) {
      const task = getRegisteredTask(taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      return task.authenticate(methodId);
    },
    retryAfterAuth() {
      const task = getRegisteredTask(taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      task.retryHeldPrompt();
      return { ok: true };
    },
  };
}

function turnHandle(turnId: string): AgentTurnHandle {
  return {
    turnId,
    get: () => agentTurnsCollection.get(turnId),
  };
}

function workspaceHandle(workspacePath: string): AgentWorkspaceHandle {
  return {
    workspacePath,
    async createTask(harness) {
      const taskId = await startAgentTask(workspacePath, harness);
      return taskHandle(taskId);
    },
  };
}

export const agents = {
  task: taskHandle,
  turn: turnHandle,
  workspace: workspaceHandle,
};
