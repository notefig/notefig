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
import type {
  HarnessDefinition,
  RequestPermissionResponse,
  TurnOutcome,
} from "@metrists/shared/agent";
import {
  agentInteractionsCollection,
  agentTurnsCollection,
  type AgentTurn,
} from "./agent-collections";
import {
  cancelAgentTask,
  getRegisteredTask,
  respondToAgentPermission,
  startAgentTask,
} from "./agent-service";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type PromptHandle = { turnId: string; completed: Promise<TurnOutcome> };

export interface AgentTaskHandle {
  readonly taskId: string;
  /** Fails as a value if the task is missing/disposed rather than throwing. */
  prompt(text: string): PromptHandle | { ok: false; error: string };
  cancel(): Promise<ActionResult>;
  respondPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): ActionResult;
}

export interface AgentTurnHandle {
  readonly turnId: string;
  /** Current row, or undefined if the turn/task has been disposed and its
   *  rows cleared. */
  get(): AgentTurn | undefined;
}

export interface AgentInteractionHandle {
  readonly interactionId: string;
  answer(text: string): ActionResult;
  cancel(): ActionResult;
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
      if (!task) return { ok: false, error: "agent task is not started" };
      return task.prompt(text);
    },
    async cancel() {
      const task = getRegisteredTask(taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      await cancelAgentTask(taskId);
      return { ok: true };
    },
    respondPermission(requestId, response) {
      if (!getRegisteredTask(taskId)) {
        return { ok: false, error: "agent task is not started" };
      }
      respondToAgentPermission(taskId, requestId, response);
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

function interactionHandle(interactionId: string): AgentInteractionHandle {
  return {
    interactionId,
    answer(text) {
      const row = agentInteractionsCollection.get(interactionId);
      if (!row) return { ok: false, error: "interaction not found" };
      const task = getRegisteredTask(row.taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      task.answerInteraction(interactionId, text);
      return { ok: true };
    },
    cancel() {
      const row = agentInteractionsCollection.get(interactionId);
      if (!row) return { ok: false, error: "interaction not found" };
      const task = getRegisteredTask(row.taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      task.cancelInteraction(interactionId);
      return { ok: true };
    },
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
  interaction: interactionHandle,
  workspace: workspaceHandle,
};
