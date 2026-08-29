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
  type PromptContextPart,
  type RequestPermissionResponse,
  type TurnOutcome,
} from "@notefig/shared/agent";
import {
  agentTasksCollection,
  agentTurnsCollection,
  whenAgentTasksReconciled,
  type AgentTurn,
} from "./agent-collections";
import { getRegisteredTask } from "./task-registry";
// Deferred-use import (see agent-service.ts's matching note): only
// `workspaceHandle.createTask` and `taskHandle.prompt`'s revival path reach
// back into the service, at call time.
import { getOrReviveTask, startAgentTask } from "./agent-service";
import { encodeWidgetContextUri } from "@notefig/agent";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type PromptHandle = { turnId: string; completed: Promise<TurnOutcome> };

export interface AgentTaskHandle {
  readonly taskId: string;
  /**
   * Enqueue a prompt — infallible, never throws. A missing/disposed task
   * returns a handle whose `completed` is already resolved as an error.
   */
  prompt(
    text: string,
    options?: { contextParts?: PromptContextPart[]; front?: boolean },
  ): PromptHandle;
  /**
   * The in-document widget's send path (MET-68): callers hand over plain
   * editor-derived facts (document path, ProseMirror position, whether the
   * doc is empty) — this method owns turning that into either an embedded
   * "author into this empty doc" framing sentence, or a `resource_link`
   * pointing at a self-contained widget-context resource URI (see
   * widget-context-uri.ts), so no MCP/ACP-shaped types need to reach into
   * the React layer.
   */
  promptFromWidget(
    text: string,
    widget: { path: string; pos: number; isDocEmpty: boolean },
    /** Additional parts riding along with the widget context — file
     *  @-mentions (MET-80). Kept even on the empty-doc branch, which
     *  otherwise carries no contextParts. */
    extraContextParts?: PromptContextPart[],
  ): PromptHandle;
  /**
   * Can this task still be prompted? True for a live runtime and for a
   * restored row that `prompt` would revive via session/load (MET-163: a
   * widget persisted in a document outlives the runtime that served it, and
   * must tell "your session is gone" apart from "your session is asleep").
   *
   * Async because a missing row only means "gone for good" once boot
   * reconciliation has settled — before that the collection may still be
   * loading.
   */
  isReachable(): Promise<boolean>;
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
  // A local reference (not `this.prompt`) so promptFromWidget below stays
  // correct even if a caller destructures the returned handle.
  const promptImpl: AgentTaskHandle["prompt"] = (text, options) => {
    // getOrReviveTask revives a restored session transparently — the
    // prompt rides the queue while session/load replays history.
    const task = getOrReviveTask(taskId);
    if (!task) {
      return {
        turnId: newTurnId(),
        completed: Promise.resolve<TurnOutcome>({
          status: "error",
          error: "agent task is not started",
        }),
      };
    }
    return task.prompt(text, options);
  };

  return {
    taskId,
    prompt: promptImpl,
    promptFromWidget(text, widget, extraContextParts = []) {
      if (widget.isDocEmpty) {
        // The one deliberately-embedded exception: the agent can't
        // discover "this doc is empty" by reading a resource it doesn't
        // know to ask for, so this stays inline in the prompt text. The
        // widget_respond directive rides along too — this branch carries
        // no widget-context resource_link, so the widget-keyed steering in
        // serverInstructions() (mcp-server.ts) never fires for it. Mention
        // parts (file:// links) still ride along; the steering keys on the
        // widget-context URI scheme, not resource_link presence.
        const framing = `${widget.path} is currently empty. Author directly into it — do not just describe what you would write. When finished, deliver a brief confirmation (or any issues) via the \`widget_respond\` tool, not as plain chat text.\n\n`;
        return promptImpl(
          framing + text,
          extraContextParts.length
            ? { contextParts: extraContextParts }
            : undefined,
        );
      }
      const uri = encodeWidgetContextUri({
        path: widget.path,
        pos: widget.pos,
      });
      return promptImpl(text, {
        contextParts: [
          { kind: "resource_link", path: uri },
          ...extraContextParts,
        ],
      });
    },
    async isReachable() {
      if (getRegisteredTask(taskId)) return true;
      const reconciled = await whenAgentTasksReconciled();
      if (getRegisteredTask(taskId)) return true;
      const row = agentTasksCollection.get(taskId);
      // Exactly reviveAgentTask's precondition — a row that is anything else
      // (already demoted to "unavailable", or session-less) can never come
      // back, and says so on its own authority.
      if (row) return row.status === "restored" && Boolean(row.sessionId);
      // No row AND no trustworthy reconciliation is "don't know", not
      // "gone": storage that failed to load looks exactly like a user with
      // no sessions. Callers destroy persisted widgets on a false answer,
      // so an infrastructure failure must never produce one.
      return !reconciled;
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
      // Programmatic callers (subagent pattern) prompt right after — wait
      // for the session to be ready, unlike the UI which opens the tab on
      // the "starting" row.
      const { taskId, started } = startAgentTask(workspacePath, harness);
      await started;
      return taskHandle(taskId);
    },
  };
}

export const agents = {
  task: taskHandle,
  turn: turnHandle,
  workspace: workspaceHandle,
};
