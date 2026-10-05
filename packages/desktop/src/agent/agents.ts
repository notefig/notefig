/**
 * Entity handles for agent state — the one way code outside `agent/`
 * touches tasks, turns and interactions (also `core.agents`). Handles carry
 * actions + identity; reads keep flowing through the collections /
 * `useLiveQuery` (handles are not a second state cache).
 *
 * The underlying free functions (`startAgentTask`, `cancelAgentTask`, …) in
 * `agent-service.ts` are the implementation — this module reorganizes access
 * to them, it does not duplicate their logic. Nothing outside `agent/`
 * imports them.
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
// Deferred-use import (see agent-service.ts's matching note): the handles
// reach back into the service only at call time.
import {
  cancelAgentTurnAndForget,
  deleteAgentSession,
  findBlobAuthorTask,
  getOrReviveTask,
  getWorkspaceTaskManager,
  refreshAgentSession,
  removeQueuedPrompt,
  reviveAgentTask,
  setAgentTaskConfigOption,
  startAgentTask,
} from "./agent-service";
import { ensureAgentRuntime } from "./tunnel/require-connection";
import { encodeWidgetContextUri } from "@notefig/agent";
import { appCore } from "@/core/current";
import { emitAppEvent } from "@/utils/app-events";
import { getOrCreateKvCollection, writeKv } from "@/utils/kv-store";
import { path as pathutil, workspaceKey } from "@/utils/path";

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
    widget: {
      /** The workspace the widget's document is in. */
      workspacePath: string;
      /** The document, absolute or relative to `workspacePath`. */
      path: string;
      pos: number;
      isDocEmpty: boolean;
      /** The selection the widget was summoned over (doc references) —
       *  quoted into the prompt text as a markdown blockquote, with its
       *  capture-time range riding the context URI so the agent can hand
       *  the same from/to to `document_read_range`. */
      reference?: { text: string; from: number; to: number };
    },
    /** Additional parts riding along with the widget context — file
     *  @-mentions (MET-80). Kept even on the empty-doc branch, which
     *  otherwise carries no contextParts. */
    extraContextParts?: PromptContextPart[],
  ): PromptHandle;
  /** Remove one queued (not yet running) prompt. */
  removeQueuedPrompt(turnId: string): void;
  /**
   * Can this task still be prompted? True for a live runtime and for a
   * restored row that `prompt` would revive via session/load (MET-163: a
   * widget persisted in a document outlives the runtime that served it, and
   * must tell "your session is gone" apart from "your session is asleep").
   *
   * Async because a missing row only means "gone" once boot reconciliation
   * has settled — before that the collection may still be loading. Even
   * then a false answer means "route this prompt at a new session", never
   * "delete the user's widget": wiped storage answers false for everything.
   */
  isReachable(): Promise<boolean>;
  cancel(): Promise<ActionResult>;
  /**
   * Cancel the running turn and, if the agent had not answered yet, remove
   * it from the transcript (Escape-to-restore, MET-94). True when it was
   * forgotten: the caller puts the prompt back in the composer.
   */
  cancelTurnAndForget(): Promise<boolean>;
  /** Bring a restored session back to life (session/load); a no-op for a
   *  live one. */
  revive(): void;
  /** Pull the harness's session store back in: re-sync a live task in
   *  place, or revive a restored one. Failures land on the row. */
  refresh(): void;
  /** Remove the session everywhere: runtime, transcript, persisted row. */
  delete(): Promise<void>;
  /** Show its chat tab. */
  open(): void;
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
  /**
   * Switch one of the session's settings (mode, model, …) to `value` —
   * the composer's pickers (MET-81). Reads come off the task row's
   * `configOptions`; a restored row revives first. Rejections come back as
   * values and leave the row showing the real current value.
   */
  setConfigOption(optionId: string, value: string): Promise<ActionResult>;
}

export interface AgentTurnHandle {
  readonly turnId: string;
  /** Current row, or undefined if the turn/task has been disposed and its
   *  rows cleared. */
  get(): AgentTurn | undefined;
}

/** What a user-started session came to (`workspace(ws).start`). */
export type StartResult =
  | { status: "started"; taskId: string }
  /** First session in this workspace: confirm with the user, `trust()`,
   *  then start again. Nothing was started. */
  | { status: "needs-trust" }
  /** Nowhere to run it (the web with no paired machine); the user has
   *  been told how to connect one. */
  | { status: "no-runtime" };

export interface AgentWorkspaceHandle {
  readonly workspacePath: string;
  /**
   * The user starts a session: the runtime gate, then the trust gate, then
   * the task, whose chat tab opens at once. The row exists (status
   * "starting") before the spawn and handshake finish; a failed start
   * shows on the row as "error". Waits only for the saved trust answers to
   * load, which on a warm app they already have.
   */
  start(harness: HarnessDefinition): Promise<StartResult>;
  /** Whether the user has agreed to run agents in this workspace. */
  isTrusted(): boolean;
  trust(): void;
  /**
   * Start a task with no gates and no tab: for code that already holds
   * the user's go-ahead (a widget's send). `started` settles when it can
   * be prompted.
   */
  startTask(harness: HarnessDefinition): {
    taskId: string;
    started: Promise<void>;
  };
  /** Start one and wait until it can be prompted (the subagent pattern). */
  createTask(harness: HarnessDefinition): Promise<AgentTaskHandle>;
  /** Ids of the live tasks (none until one starts). Driven by id. */
  liveTaskIds(): string[];
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

  const sendFromWidget = (
    text: string,
    widget: Parameters<AgentTaskHandle["promptFromWidget"]>[1],
    extraContextParts: PromptContextPart[],
  ): PromptHandle => {
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
      ...(widget.reference
        ? {
            selectedRange: {
              from: widget.reference.from,
              to: widget.reference.to,
            },
          }
        : {}),
    });
    // The referenced passage leads the prompt as a markdown blockquote —
    // visible to the agent AND rendered as a quote in the chat transcript
    // (the second deliberately-embedded exception, like the empty-doc
    // framing above: the quote IS part of what the user said).
    const quoted = widget.reference
      ? `${widget.reference.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n${text}`
      : text;
    return promptImpl(quoted, {
      contextParts: [
        { kind: "resource_link", path: uri },
        ...extraContextParts,
      ],
    });
  };

  return {
    taskId,
    prompt: promptImpl,
    promptFromWidget(text, widget, extraContextParts = []) {
      const sent = sendFromWidget(text, widget, extraContextParts);
      // The round begins in the widget's document — announced here, by
      // the one send path, so no caller can send without it.
      emitAppEvent("widget:round-started", {
        taskId,
        turnId: sent.turnId,
        workspacePath: widget.workspacePath,
        documentPath: pathutil.isAbsolute(widget.path)
          ? widget.path
          : pathutil.join(widget.workspacePath, widget.path),
        prompt: text,
      });
      return sent;
    },
    removeQueuedPrompt(turnId) {
      removeQueuedPrompt(taskId, turnId);
    },
    async isReachable() {
      if (getRegisteredTask(taskId)) return true;
      await whenAgentTasksReconciled();
      if (getRegisteredTask(taskId)) return true;
      const row = agentTasksCollection.get(taskId);
      // Exactly reviveAgentTask's precondition: anything else — no row at
      // all, a row already demoted to "unavailable", or one with no session
      // to resume — is a task no prompt can reach.
      if (!row) return false;
      return row.status === "restored" && Boolean(row.sessionId);
    },
    async cancel() {
      const task = getRegisteredTask(taskId);
      if (!task) return { ok: false, error: "agent task is not started" };
      await task.cancel();
      return { ok: true };
    },
    cancelTurnAndForget: () => cancelAgentTurnAndForget(taskId),
    revive() {
      reviveAgentTask(taskId);
    },
    refresh: () => refreshAgentSession(taskId),
    delete: () => deleteAgentSession(taskId),
    open() {
      appCore().tabs.openAgent(taskId);
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
    setConfigOption(optionId, value) {
      return setAgentTaskConfigOption(taskId, optionId, value);
    },
  };
}

function turnHandle(turnId: string): AgentTurnHandle {
  return {
    turnId,
    get: () => agentTurnsCollection.get(turnId),
  };
}

/** Where a workspace's "run agents here" answer is kept (KV "agent"). */
export const AGENT_KV_NAMESPACE = "agent";
export function trustKey(workspacePath: string): string {
  return `trust:${workspaceKey(workspacePath)}`;
}

/**
 * Trust granted in this run. The KV write is durable only after it lands,
 * but the start the user just confirmed must see the answer at once.
 */
const trustedThisRun = new Set<string>();

function workspaceHandle(workspacePath: string): AgentWorkspaceHandle {
  const key = trustKey(workspacePath);
  const isTrusted = () =>
    trustedThisRun.has(key) ||
    getOrCreateKvCollection(AGENT_KV_NAMESPACE).get(key)?.value === true;
  return {
    workspacePath,
    async start(harness) {
      if (!ensureAgentRuntime()) return { status: "no-runtime" };
      // A cold start may click before the answers load; reading then would
      // ask again about a workspace the user already trusted.
      await getOrCreateKvCollection(AGENT_KV_NAMESPACE).preload();
      if (!isTrusted()) return { status: "needs-trust" };
      const { taskId, started } = startAgentTask(workspacePath, harness);
      // The tab opens on the "starting" row rather than sitting on the
      // multi-second spawn and handshake.
      appCore().tabs.openAgent(taskId);
      started.catch((error) => {
        console.error("Failed to start agent task:", error);
      });
      return { status: "started", taskId };
    },
    isTrusted,
    trust() {
      trustedThisRun.add(key);
      void writeKv(AGENT_KV_NAMESPACE, key, true);
    },
    startTask: (harness) => startAgentTask(workspacePath, harness),
    async createTask(harness) {
      // Programmatic callers (subagent pattern) prompt right after — wait
      // for the session to be ready, unlike the UI which opens the tab on
      // the "starting" row.
      const { taskId, started } = startAgentTask(workspacePath, harness);
      await started;
      return taskHandle(taskId);
    },
    liveTaskIds: () =>
      (getWorkspaceTaskManager(workspacePath)?.listTasks() ?? []).map(
        (task) => task.taskId,
      ),
  };
}

export const agents = {
  task: taskHandle,
  turn: turnHandle,
  workspace: workspaceHandle,
  /** Which task authored a blob (from its `author_blob` call), if any. */
  blobAuthor: findBlobAuthorTask,
  /**
   * Whether a new session can run here: always on desktop; on the web only
   * with a paired machine (otherwise the user is shown how to pair one).
   * Call before starting a task, not before prompting a live one.
   */
  ensureRuntime: ensureAgentRuntime,
};

export type AgentsApi = typeof agents;

/**
 * The inverse of promptFromWidget's quote prepend, kept beside it: a prompt
 * sent from a summoned-over-selection widget opens with a markdown
 * blockquote of the referenced passage. The quote is part of what the agent
 * receives, but not part of what the user "said" — consumers that present
 * the prompt back (the chat bubble, the session name derived from the first
 * prompt) split it off with this. Only a LEADING quote is the convention;
 * quotes mid-prompt are the user's own text.
 */
export function splitLeadingQuote(text: string): {
  quote: string | null;
  rest: string;
} {
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && /^> ?/.test(lines[end])) end++;
  if (end === 0) return { quote: null, rest: text };
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n");
  const rest = lines.slice(end).join("\n").replace(/^\n+/, "");
  return { quote, rest };
}
