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
import { discardPromptChanges, type PromptChange } from "./change-store";
import type { RoundOutcome } from "./state";
import {
  COMPOSING,
  stateFromRound,
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
  /** Watch the newest round the app stored for a widget (MET-251). Absent:
   *  nothing is stored, and a widget's round lives as long as its rows. */
  observeStoredRound?: (
    blobId: string,
    onChange: () => void,
  ) => StoredRoundObservation;
  /** Where a document's review ranges are kept between runs (MET-251).
   *  Absent: they live as long as the run. */
  reviewRanges?: ReviewRangeStore;
}

/** A document's review ranges, with the fingerprint of the document they
 *  were mapped onto — they only mean something against that document. */
export type SavedReviewRanges = {
  fingerprint: string;
  changes: PromptChange[];
};

export interface ReviewRangeStore {
  load(documentPath: string): SavedReviewRanges | null;
  save(documentPath: string, saved: SavedReviewRanges): void;
}

/** A widget's round as the app stored it: what outlives the turn's rows. */
export type StoredRound = {
  turnId: string;
  taskId: string;
  status: "live" | "completed" | "cancelled" | "error";
  /** The prompt as sent, whole. */
  prompt: string;
  /** Written when the round settles. */
  outcome: RoundOutcome | null;
};

export type StoredRoundObservation = {
  get(): StoredRound | undefined;
  destroy(): void;
};

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
  /** When an edit last tried and failed to delete this widget (it can't be
   *  removed while the agent works), for the face's "stop it first" hint. */
  removalRefusedAt: number | null;
  /** What the bound round left behind once it settled, as stored with it —
   *  the settled face reads this, live or restored. */
  outcome: RoundOutcome | null;
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

  /** A delete was refused: the widget can't be removed now. */
  refuseRemoval(blobId: string): void;

  /** A document's saved review ranges, if any were kept. */
  loadReviewRanges(documentPath: string): SavedReviewRanges | null;
  /** Keep a document's review ranges past this run. */
  saveReviewRanges(documentPath: string, saved: SavedReviewRanges): void;

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
   * Withdraw the bound turn if it is still queued — read off the turn's own
   * row, since a queued turn can sit behind a sign-in (`asking`). The widget
   * unbinds, so the caller can put the prompt back in the draft. False when
   * there was no queued turn to withdraw.
   */
  withdraw(blobId: string, commands: StopCommands): boolean;
  /**
   * Stop the bound round: a queued turn is withdrawn (see `withdraw`), a
   * live one cancelled.
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
  /** A mounted widget takes part in Escape; returns the release. */
  claimEscape(blobId: string): () => void;
  /** True when this widget holds the newest turn Escape can stop among the
   *  mounted widgets — the one Escape acts on. One owner across every
   *  visible document, so a keypress never stops two rounds. */
  isNewestStoppable(blobId: string): boolean;
}

const EMPTY: PromptWidget = {
  state: COMPOSING,
  boundTaskId: null,
  boundTurnId: null,
  lastSentPrompt: "",
  documentPath: null,
  removalRefusedAt: null,
  outcome: null,
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
  /** Mounted widgets taking part in Escape, by blobId → mount count. */
  const escapeClaims = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const watches = new Map<string, Watch>();
  /** Each widget's newest stored round, watched once it is touched. */
  const storedRounds = new Map<string, StoredRoundObservation>();
  /** Widgets restored from a file marker whose stored round may still be
   *  loading: adopted when it arrives, unless the user acts first. */
  const pendingRestore = new Set<string>();

  const get = (blobId: string) => widgets.get(blobId) ?? EMPTY;
  /** Kept by the app, or for this run only when it keeps none. */
  const reviewRanges = deps.reviewRanges ?? inMemoryReviewRanges();

  /** The stored round of the turn the widget is bound to, once settled. */
  const settledOnRecord = (blobId: string): StoredRound | undefined => {
    const stored = storedRounds.get(blobId)?.get();
    const { boundTurnId } = get(blobId);
    return stored && stored.turnId === boundTurnId && stored.status !== "live"
      ? stored
      : undefined;
  };

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
    if (next.boundTurnId !== previous.boundTurnId) {
      widgets.set(blobId, {
        ...next,
        outcome: settledOnRecord(blobId)?.outcome ?? null,
      });
    }
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
   *  whose row is gone is stale (withdrawn, forgotten, replayed away when
   *  the session is revived): the widget drops the turn instead of
   *  rendering a dead round. It keeps the session — a missing turn row says
   *  nothing about the session, and the file marker follows the session, so
   *  dropping it here would strip markers from every widget on a revived
   *  session. */
  const fold = (blobId: string, watch: Watch) => {
    const widget = get(blobId);
    if (widget.state.name === "sending") return;
    const facts: RoundFacts = {
      ...factsOf(watch.observation.get()),
      settled: settledOnRecord(blobId)?.status as RoundFacts["settled"],
    };
    if (facts.turn !== undefined) watch.seenTurn = true;
    // Settled on record: the round stands even with its turn row gone.
    if (widget.boundTurnId && facts.turn === undefined && !facts.settled) {
      if (!watch.seenTurn) return;
      write(blobId, {
        state: transition(widget.state, { type: "unbound" }),
        boundTurnId: null,
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

  /** Watch the widget's newest stored round, once. */
  const watchStored = (blobId: string) => {
    if (!deps.observeStoredRound || storedRounds.has(blobId)) return;
    storedRounds.set(
      blobId,
      deps.observeStoredRound(blobId, () => onStored(blobId)),
    );
  };

  /** A widget restored from its file marker takes up its last round when
   *  that round settled on the same session: it comes back as it was left,
   *  not as a blank composer. */
  const adoptStored = (blobId: string) => {
    if (!pendingRestore.has(blobId)) return;
    const stored = storedRounds.get(blobId)?.get();
    const widget = get(blobId);
    if (!stored || stored.status === "live") return;
    pendingRestore.delete(blobId);
    if (widget.boundTurnId || widget.boundTaskId !== stored.taskId) return;
    write(blobId, {
      boundTurnId: stored.turnId,
      lastSentPrompt: stored.prompt,
      state: stateFromRound({
        turn: undefined,
        authRequired: false,
        pendingPermission: false,
        settled: stored.status,
      }),
    });
  };

  function onStored(blobId: string) {
    adoptStored(blobId);
    write(blobId, { outcome: settledOnRecord(blobId)?.outcome ?? null });
    const watch = watches.get(blobId);
    if (watch) fold(blobId, watch);
    emit(blobId);
  }

  const unbind = (blobId: string) => {
    pendingRestore.delete(blobId);
    write(blobId, {
      state: transition(get(blobId).state, { type: "unbound" }),
      boundTaskId: null,
      boundTurnId: null,
    });
  };

  /** The bound turn's status as its row says, else as the machine last
   *  saw it (a just-dispatched turn whose row isn't written yet). */
  const turnStatus = (blobId: string) => {
    const row = watches.get(blobId)?.observation.get().turn;
    if (row) return row.status;
    const { state } = get(blobId);
    return state.name === "working" ? state.turn : undefined;
  };

  const withdraw = (blobId: string, commands: StopCommands) => {
    const { boundTaskId, boundTurnId } = get(blobId);
    if (!boundTaskId || !boundTurnId || turnStatus(blobId) !== "queued") {
      return false;
    }
    commands.removeQueuedPrompt(boundTaskId, boundTurnId);
    unbind(blobId);
    return true;
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
      watchStored(blobId);
      write(blobId, { documentPath });
    },
    restore(blobId, taskId) {
      if (get(blobId).boundTaskId) return;
      pendingRestore.add(blobId);
      watchStored(blobId);
      write(blobId, { boundTaskId: taskId });
      adoptStored(blobId);
    },
    rebind(blobId, taskId) {
      pendingRestore.delete(blobId);
      write(blobId, {
        state: transition(get(blobId).state, { type: "unbound" }),
        boundTaskId: taskId,
        boundTurnId: null,
      });
    },
    unbind,

    refuseRemoval: (blobId) => write(blobId, { removalRefusedAt: Date.now() }),
    loadReviewRanges: (documentPath) => reviewRanges.load(documentPath),
    saveReviewRanges: (documentPath, saved) =>
      reviewRanges.save(documentPath, saved),
    askTrust: (blobId) => fire(blobId, { type: "trustAsked" }),
    answerTrust: (blobId) => fire(blobId, { type: "trustAnswered" }),

    async send(blobId, prompt, dispatch) {
      const before = get(blobId).state;
      const sending = transition(before, { type: "sendStarted" });
      if (sending === before) return false;
      pendingRestore.delete(blobId);
      watchStored(blobId);
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

    withdraw,
    stop(blobId, commands) {
      const { boundTaskId, boundTurnId } = get(blobId);
      if (!boundTaskId || !boundTurnId) return "none";
      if (withdraw(blobId, commands)) return "withdrawn";
      commands.cancelTask(boundTaskId);
      return "cancelled";
    },

    findByTask,
    claimEscape(blobId) {
      escapeClaims.set(blobId, (escapeClaims.get(blobId) ?? 0) + 1);
      return () => {
        const count = (escapeClaims.get(blobId) ?? 1) - 1;
        if (count > 0) escapeClaims.set(blobId, count);
        else escapeClaims.delete(blobId);
      };
    },
    isNewestStoppable(blobId) {
      const mine = get(blobId);
      if (!escapeClaims.has(blobId) || !stoppable(mine)) return false;
      for (const otherId of escapeClaims.keys()) {
        const other = get(otherId);
        if (other === mine || !stoppable(other)) continue;
        if (other.boundTurnId! > mine.boundTurnId!) return false;
      }
      return true;
    },
  };
}

function inMemoryReviewRanges(): ReviewRangeStore {
  const byDocument = new Map<string, SavedReviewRanges>();
  return {
    load: (documentPath) => byDocument.get(documentPath) ?? null,
    save: (documentPath, saved) => {
      byDocument.set(documentPath, saved);
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
