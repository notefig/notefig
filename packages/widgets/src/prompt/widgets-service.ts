/**
 * Every prompt widget's state, by `blobId` — the one place it lives.
 *
 * A widget is a document node plus a round with an agent. The node holds the
 * draft and the ids that go into the file; this service holds the rest: the
 * state machine (./machine.ts), the session and turn the widget is bound to,
 * the last prompt it sent, and the document it was last mounted in. The
 * face, the document plugins, the minimap and the app (jump-to-widget,
 * change attribution) all read it here, so none of them can disagree.
 *
 * The agent's side is observed, not told: the service watches the bound
 * round's rows through `observeRound` and folds each change into the
 * machine, so a reload, a turn settled from the chat tab or a sign-in
 * finished elsewhere all land the same way.
 *
 * Ephemeral by design, like the agent collections: nothing persists across
 * app runs. A widget restored from the file comes back through `restore`.
 */
import type {
  AgentEntry,
  AgentTaskRow,
  AgentTurn,
} from "@notefig/shared/agent";
import { discardPromptChanges } from "./change-store";
import {
  COMPOSING,
  transition,
  type RoundFacts,
  type WidgetEvent,
  type WidgetState,
} from "./machine";

/** One bound round's live rows. */
export type PromptRoundSnapshot = {
  turn: AgentTurn | undefined;
  task: AgentTaskRow | undefined;
  /** Every turn on the bound task — for the queue-position readout. */
  taskTurns: AgentTurn[];
  hasPendingPermission: boolean;
  /** The bound turn's transcript. */
  entries: AgentEntry[];
};

export type PromptRoundObservation = {
  get(): PromptRoundSnapshot;
  destroy(): void;
};

/** Watch one round's rows; `onChange` fires on any change to them. */
export type PromptRoundObserverFactory = (
  args: { turnId: string | null; taskId: string | null },
  onChange: () => void,
) => PromptRoundObservation;

/** What the service needs from the agent side: a way to watch a round.
 *  It never drives the agent itself — sending and stopping are handed the
 *  commands by their caller. */
export interface PromptWidgetsDeps {
  observeRound: PromptRoundObserverFactory;
}

/** The agent commands a stop runs. */
export interface StopCommands {
  cancelTask(taskId: string): void;
  /** Withdraw a turn that is still queued behind others. */
  removeQueuedPrompt(taskId: string, turnId: string): void;
}

export type PromptWidget = {
  state: WidgetState;
  /** The session this widget prompts; null while it belongs to none. */
  boundTaskId: string | null;
  /** The turn this widget watches, or null. */
  boundTurnId: string | null;
  /** Last sent prompt text, for the Edit affordance and the status row. */
  lastSentPrompt: string;
  /** Absolute path of the document the widget was last mounted in, so the
   *  app can find its way from a session back to the widget. Null until
   *  the widget has mounted this run. */
  documentPath: string | null;
};

/** A widget bound to a session, located in its document. */
export type PromptWidgetLocation = {
  blobId: string;
  documentPath: string;
  boundTurnId: string | null;
};

export interface PromptWidgetsApi {
  /** Stable snapshot: the same object until the widget changes. */
  get(blobId: string): PromptWidget;
  subscribe(blobId: string, listener: () => void): () => void;
  /** The bound round's live rows, or undefined when nothing is bound. */
  round(blobId: string): PromptRoundSnapshot | undefined;

  /** Record where a widget is mounted. Silent when unchanged. */
  setDocument(blobId: string, documentPath: string): void;
  /** Seed the session a widget carried in its file marker. Never clobbers a
   *  live binding: an agent rewriting the file mid-round re-parses the
   *  widget with the same ids it already holds. */
  restore(blobId: string, taskId: string): void;
  /** Point the widget at a session without a round (the session picker). */
  rebind(blobId: string, taskId: string): void;
  /** Stop watching any round and drop the session (Edit, dismiss). The last
   *  sent prompt stays, for the Edit affordance. */
  unbind(blobId: string): void;

  /** The workspace trust warning, armed by a first Send. */
  askTrust(blobId: string): void;
  answerTrust(blobId: string): void;
  /**
   * Run one send. `dispatch` resolves the session and sends the prompt; the
   * service moves the widget through `sending` and binds what it returns.
   * False when the widget can't send now or the dispatch failed.
   */
  send(
    blobId: string,
    prompt: string,
    dispatch: () => Promise<{ taskId: string; turnId: string }>,
  ): Promise<boolean>;
  /**
   * Stop the bound round: a queued turn is withdrawn (the widget unbinds, so
   * the caller can put the prompt back in the draft), a live one cancelled.
   */
  stop(
    blobId: string,
    commands: StopCommands,
  ): "withdrawn" | "cancelled" | "none";

  /** The widget to reveal for a task (see findByTask below). */
  findByTask(
    taskId: string,
    preferTurnId?: string | null,
  ): PromptWidgetLocation | null;
  /** True when this widget holds the newest turn Escape can stop among the
   *  widgets in its document — the one Escape acts on. */
  isNewestStoppable(blobId: string): boolean;
}

const EMPTY: PromptWidget = {
  state: COMPOSING,
  boundTaskId: null,
  boundTurnId: null,
  lastSentPrompt: "",
  documentPath: null,
};

type Watch = {
  turnId: string | null;
  taskId: string | null;
  observation: PromptRoundObservation;
  /** The bound turn's row has existed. Until it has, a missing row means
   *  "not written yet", not "gone". */
  seenTurn: boolean;
};

function factsOf(snapshot: PromptRoundSnapshot): RoundFacts {
  return {
    turn: snapshot.turn?.status,
    authRequired: snapshot.task?.authRequired === true,
    pendingPermission: snapshot.hasPendingPermission,
  };
}

export function createPromptWidgets(deps: PromptWidgetsDeps): PromptWidgetsApi {
  const widgets = new Map<string, PromptWidget>();
  const listeners = new Map<string, Set<() => void>>();
  const watches = new Map<string, Watch>();

  const get = (blobId: string) => widgets.get(blobId) ?? EMPTY;

  const emit = (blobId: string) => {
    for (const listener of listeners.get(blobId) ?? []) listener();
  };

  const write = (blobId: string, patch: Partial<PromptWidget>) => {
    const previous = get(blobId);
    const next = { ...previous, ...patch };
    if (
      (Object.keys(patch) as (keyof PromptWidget)[]).every(
        (key) => previous[key] === next[key],
      )
    ) {
      return;
    }
    widgets.set(blobId, next);
    // Review state belongs to the watched round: a new send, a dismiss or an
    // edit rebinds the widget, and what the old round changed stops being
    // this widget's to show.
    if (next.boundTurnId !== previous.boundTurnId) discardPromptChanges(blobId);
    if (
      next.boundTurnId !== previous.boundTurnId ||
      next.boundTaskId !== previous.boundTaskId
    ) {
      rewatch(blobId);
    }
    emit(blobId);
  };

  const fire = (blobId: string, event: WidgetEvent) => {
    write(blobId, { state: transition(get(blobId).state, event) });
  };

  /** Fold the watched round's current rows into the machine. A bound turn
   *  whose row is gone is stale (withdrawn, forgotten, its task disposed):
   *  the widget unbinds instead of rendering a dead round. */
  const fold = (blobId: string, watch: Watch) => {
    const widget = get(blobId);
    if (widget.state.name === "sending") return;
    const facts = factsOf(watch.observation.get());
    if (facts.turn !== undefined) watch.seenTurn = true;
    if (widget.boundTurnId && facts.turn === undefined) {
      if (!watch.seenTurn) return;
      write(blobId, {
        state: transition(widget.state, { type: "unbound" }),
        boundTurnId: null,
        boundTaskId: null,
      });
      return;
    }
    fire(blobId, { type: "roundChanged", facts });
  };

  /** A change to the watched round's rows. Subscribers hear every one, not
   *  only state changes: what they show from the round (the queue position,
   *  the transcript) moves without the state moving. */
  const reconcile = (blobId: string) => {
    const watch = watches.get(blobId);
    if (!watch) return;
    fold(blobId, watch);
    emit(blobId);
  };

  /** Watch the rows of whatever the widget is bound to now. */
  function rewatch(blobId: string) {
    const { boundTurnId: turnId, boundTaskId: taskId } = get(blobId);
    const current = watches.get(blobId);
    if (current && current.turnId === turnId && current.taskId === taskId) {
      return;
    }
    current?.observation.destroy();
    watches.delete(blobId);
    if (!turnId && !taskId) return;
    watches.set(blobId, {
      turnId,
      taskId,
      seenTurn: false,
      observation: deps.observeRound({ turnId, taskId }, () =>
        reconcile(blobId),
      ),
    });
  }

  const findByTask: PromptWidgetsApi["findByTask"] = (
    taskId,
    preferTurnId,
  ) => {
    let fallback: PromptWidgetLocation | null = null;
    for (const [blobId, widget] of widgets) {
      if (widget.boundTaskId !== taskId || widget.documentPath === null) {
        continue;
      }
      const location = {
        blobId,
        documentPath: widget.documentPath,
        boundTurnId: widget.boundTurnId,
      };
      if (preferTurnId && widget.boundTurnId === preferTurnId) return location;
      fallback ??= location;
    }
    // Naming a turn makes this an exact question. One workspace session is
    // shared by the chat tab and every widget in it, so a task can own both
    // kinds of round: a turn no widget is watching ran in the chat, and the
    // chat is where its permission or sign-in card is. Falling back to some
    // other widget on the same task would land the user on an unrelated
    // round they cannot answer from. Without a turn the question is
    // task-level ("where do I answer for this session?") and any bound
    // widget is a better answer than the chat.
    return preferTurnId ? null : fallback;
  };

  const unbind = (blobId: string) => {
    write(blobId, {
      state: transition(get(blobId).state, { type: "unbound" }),
      boundTaskId: null,
      boundTurnId: null,
    });
  };

  const stoppable = (widget: PromptWidget) =>
    widget.boundTurnId !== null &&
    (widget.state.name === "working" ||
      (widget.state.name === "asking" &&
        widget.state.ask.kind === "permission"));

  return {
    get,
    subscribe(blobId, listener) {
      let set = listeners.get(blobId);
      if (!set) {
        set = new Set();
        listeners.set(blobId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(blobId);
      };
    },
    round: (blobId) => watches.get(blobId)?.observation.get(),

    setDocument(blobId, documentPath) {
      write(blobId, { documentPath });
    },
    restore(blobId, taskId) {
      if (get(blobId).boundTaskId) return;
      write(blobId, { boundTaskId: taskId });
    },
    rebind(blobId, taskId) {
      write(blobId, {
        state: transition(get(blobId).state, { type: "unbound" }),
        boundTaskId: taskId,
        boundTurnId: null,
      });
    },
    unbind,

    askTrust: (blobId) => fire(blobId, { type: "trustAsked" }),
    answerTrust: (blobId) => fire(blobId, { type: "trustAnswered" }),

    async send(blobId, prompt, dispatch) {
      const before = get(blobId).state;
      const sending = transition(before, { type: "sendStarted" });
      if (sending === before) return false;
      write(blobId, { state: sending });
      try {
        const { taskId, turnId } = await dispatch();
        write(blobId, {
          boundTaskId: taskId,
          boundTurnId: turnId,
          lastSentPrompt: prompt,
        });
        // The turn row may not be written yet (a session still reviving
        // records the prompt first); until it is, the turn is queued.
        const snapshot = watches.get(blobId)?.observation.get();
        const facts = snapshot
          ? factsOf(snapshot)
          : { turn: undefined, authRequired: false, pendingPermission: false };
        fire(blobId, {
          type: "dispatched",
          facts: { ...facts, turn: facts.turn ?? "queued" },
        });
        reconcile(blobId);
        return true;
      } catch (error) {
        console.error("Prompt widget send failed:", error);
        fire(blobId, { type: "sendFailed" });
        return false;
      }
    },

    stop(blobId, commands) {
      const widget = get(blobId);
      const { boundTaskId, boundTurnId } = widget;
      if (!boundTaskId || !boundTurnId) return "none";
      if (widget.state.name === "working" && widget.state.turn === "queued") {
        commands.removeQueuedPrompt(boundTaskId, boundTurnId);
        unbind(blobId);
        return "withdrawn";
      }
      commands.cancelTask(boundTaskId);
      return "cancelled";
    },

    findByTask,
    isNewestStoppable(blobId) {
      const mine = get(blobId);
      if (!stoppable(mine)) return false;
      for (const other of widgets.values()) {
        if (other === mine || !stoppable(other)) continue;
        if (other.documentPath !== mine.documentPath) continue;
        if (other.boundTurnId! > mine.boundTurnId!) return false;
      }
      return true;
    },
  };
}

/** A service with no agent behind it: every round reads as empty. For
 *  editors built without the app (tests, schema-only contexts). */
export function inertPromptWidgets(): PromptWidgetsApi {
  return createPromptWidgets({
    observeRound: () => ({
      get: () => ({
        turn: undefined,
        task: undefined,
        taskTurns: [],
        hasPendingPermission: false,
        entries: [],
      }),
      destroy() {},
    }),
  });
}
