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
 * What a round left behind is the app's record of it (`observeStoredRound`,
 * MET-251): the service announces each round it starts (`announceRound`),
 * the app records it, and finishes the record when the round ends. Whether
 * a round has ended, and what it left, is read from that record alone
 * (`roundStatus`), live or after a restart, so the face can't show an
 * ended round without what it left. The turn's rows say only how a live
 * round is going. What its rounds changed in each document is the
 * service's review store (`review`, ./change-store.ts), kept by the app
 * the same way. The rest of the service's state is for this run: a widget
 * restored from the file comes back through `restore`, which takes up its
 * last recorded round.
 */
import type { AgentTaskRow, AgentTurn } from "@notefig/shared/agent";
import {
  createPromptReview,
  NO_SAVED_REVIEW_RANGES,
  type PromptReview,
  type ReviewRangeStore,
} from "./change-store";
import type { RoundOutcome } from "./state";
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

/** What the service needs from the app: a way to watch a round, the
 *  record it keeps of each one, and where it keeps review ranges. It never
 *  drives the agent itself — sending and stopping are handed the commands
 *  by their caller. */
export interface PromptWidgetsDeps {
  observeRound: PromptRoundObserverFactory;
  /** Watch the newest round the app recorded for a widget (MET-251). */
  observeStoredRound: (
    blobId: string,
    onChange: () => void,
  ) => StoredRoundObservation;
  /** A widget started a round: the app records it. */
  announceRound(round: RoundStart): void;
  /** Where a document's review ranges are kept between runs (MET-251). */
  reviewRanges: ReviewRangeStore;
}

/** What a send's dispatch hands back: the round it started, and where. */
export type DispatchedRound = {
  taskId: string;
  turnId: string;
  workspacePath: string;
  /** Absolute path of the document the widget sent from. */
  documentPath: string;
  /** The prompt as it went out, directives taken out. */
  sentPrompt: string;
};

/** A round a widget started, as the service announces it. */
export type RoundStart = Omit<DispatchedRound, "sentPrompt"> & {
  blobId: string;
  /** The prompt as sent. */
  prompt: string;
  /** The prompt as the user typed it, directives and all — what Edit and
   *  Retry put back. */
  typedPrompt: string;
};

/** How a recorded round stands: "live" until it ends, then how it ended. */
export type RecordStatus = "live" | "completed" | "cancelled" | "error";

/** A widget's round as the app stored it: what outlives the turn's rows. */
export type StoredRound = {
  turnId: string;
  taskId: string;
  status: RecordStatus;
  /** The prompt as the user typed it, directives and all. */
  prompt: string;
  /** Written when the round settles. */
  outcome: RoundOutcome | null;
};

export type StoredRoundObservation = {
  /** Stable: the same object until the record changes. */
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
  /** What the bound round left behind once it settled, as recorded — the
   *  settled face reads this, live or restored. */
  outcome: RoundOutcome | null;
  /** The bound round once the user has seen how it ended (scrolled to it,
   *  or it was already over when the widget took it up from a restore). */
  seenTurnId: string | null;
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
  /** What every widget's rounds changed in each document. */
  readonly review: PromptReview;

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
  /** The user has seen how the bound round ended. */
  markSeen(blobId: string): void;

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
    dispatch: () => Promise<DispatchedRound>,
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
  seenTurnId: null,
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

/**
 * Where a recorded round stands — the one answer the widget and every
 * list of rounds share. Whether it has ended, and how, is the record's to
 * say: the same record the face reads the outcome from.
 *
 * - A turn row that has ended while its record hasn't yet (or before the
 *   record is even written) holds as running for that moment.
 * - A live turn whose record has ended is a retry the record hasn't
 *   reopened for yet: the turn says.
 * - A round still live on record whose turn row is gone (withdrawn,
 *   purged, replayed away by a revival) is over: cancelled, the same
 *   answer the app writes for it at its next start. Until the row has
 *   existed (`turnGone` false), a missing row is one not written yet:
 *   undefined.
 */
export function roundStatus(
  record: RecordStatus | undefined,
  turn: AgentTurn["status"] | undefined,
  turnGone: boolean,
): AgentTurn["status"] | undefined {
  if (record !== undefined && record !== "live") {
    return turn === "queued" || turn === "running" ? turn : record;
  }
  if (turn === undefined) return turnGone ? "cancelled" : undefined;
  return turn === "queued" ? turn : "running";
}

export function createPromptWidgets(deps: PromptWidgetsDeps): PromptWidgetsApi {
  const widgets = new Map<string, PromptWidget>();
  /** Mounted widgets taking part in Escape, by blobId → mount count. */
  const escapeClaims = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const watches = new Map<string, Watch>();
  /** Each widget's newest stored round, watched once it is touched. */
  const storedRounds = new Map<string, StoredRoundObservation>();
  /** Widgets restored from a file marker that haven't taken up their last
   *  recorded round yet — its record may still be loading. */
  const pendingRestore = new Set<string>();

  const get = (blobId: string) => widgets.get(blobId) ?? EMPTY;
  const review = createPromptReview(deps.reviewRanges);

  /** The record of the round the widget is bound to. */
  const recordOf = (blobId: string): StoredRound | undefined => {
    const stored = storedRounds.get(blobId)?.get();
    return stored && stored.turnId === get(blobId).boundTurnId
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
    // Review state belongs to the watched round: a new send, a dismiss or an
    // edit moves the widget off its round, and what that round changed
    // stops being this widget's to show — in open documents and saved
    // ones alike. Taking a round up (a restore adopting its stored round)
    // is not moving off one: its saved ranges are what it restores.
    if (previous.boundTurnId && next.boundTurnId !== previous.boundTurnId) {
      review.discard(blobId);
    }
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

  /** Fold the watched round's current rows and its record into the
   *  machine (see `roundStatus`). Returns whether the widget changed. A
   *  round whose turn row is gone ends cancelled but keeps its session — a
   *  missing turn row says nothing about the session, and the file marker
   *  follows the session, so dropping it would strip markers from every
   *  widget on a revived session. */
  const fold = (blobId: string, watch: Watch): boolean => {
    const widget = get(blobId);
    const live = factsOf(watch.observation.get());
    if (live.turn !== undefined) watch.seenTurn = true;
    const record = recordOf(blobId);
    const turn = roundStatus(record?.status, live.turn, watch.seenTurn);
    // A bound turn whose row isn't written yet: nothing to fold.
    if (widget.boundTurnId && turn === undefined) return false;
    const ended = record && record.status !== "live";
    write(blobId, {
      state: transition(widget.state, {
        type: "roundChanged",
        facts: { ...live, turn },
      }),
      outcome: ended ? record.outcome : null,
    });
    return get(blobId) !== widget;
  };

  /** A change to the watched round's rows or its record. Subscribers hear
   *  it when the widget changed, and while it is queued: its place in the
   *  queue moves without the widget moving. */
  const reconcile = (blobId: string) => {
    const watch = watches.get(blobId);
    if (!watch) return;
    const changed = fold(blobId, watch);
    if (!changed && get(blobId).state.name === "working") emit(blobId);
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
    if (storedRounds.has(blobId)) return;
    storedRounds.set(
      blobId,
      deps.observeStoredRound(blobId, () => onStored(blobId)),
    );
  };

  /** A widget restored from its file marker binds its last recorded round
   *  when that round was on the same session — a binding like any other,
   *  so it reads the record the way a live round does and comes back as it
   *  was left, not as a blank composer. */
  const adoptStored = (blobId: string) => {
    if (!pendingRestore.has(blobId)) return;
    const stored = storedRounds.get(blobId)?.get();
    if (!stored) return;
    pendingRestore.delete(blobId);
    const widget = get(blobId);
    if (widget.boundTurnId || widget.boundTaskId !== stored.taskId) return;
    // A round taken up from a restore ended before this run: nothing new
    // to see, whenever its record catches up.
    write(blobId, {
      boundTurnId: stored.turnId,
      lastSentPrompt: stored.prompt,
      seenTurnId: stored.turnId,
    });
  };

  function onStored(blobId: string) {
    adoptStored(blobId);
    reconcile(blobId);
  }

  const unbind = (blobId: string) => {
    pendingRestore.delete(blobId);
    write(blobId, {
      state: transition(get(blobId).state, { type: "unbound" }),
      boundTaskId: null,
      boundTurnId: null,
      outcome: null,
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
    review,

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
      reconcile(blobId);
    },
    rebind(blobId, taskId) {
      pendingRestore.delete(blobId);
      write(blobId, {
        state: transition(get(blobId).state, { type: "unbound" }),
        boundTaskId: taskId,
        boundTurnId: null,
        outcome: null,
      });
    },
    unbind,

    refuseRemoval: (blobId) => write(blobId, { removalRefusedAt: Date.now() }),
    markSeen: (blobId) => write(blobId, { seenTurnId: get(blobId).boundTurnId }),
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
        const { sentPrompt, ...round } = await dispatch();
        const { taskId, turnId } = round;
        deps.announceRound({ ...round, blobId, prompt: sentPrompt, typedPrompt: prompt });
        write(blobId, {
          boundTaskId: taskId,
          boundTurnId: turnId,
          lastSentPrompt: prompt,
          outcome: null,
        });
        // The turn row may not be written yet (a session still reviving
        // records the prompt first); until it is, the turn is queued.
        const snapshot = watches.get(blobId)?.observation.get();
        const facts = snapshot
          ? factsOf(snapshot)
          : { turn: undefined, authRequired: false, pendingPermission: false };
        const turn = facts.turn
          ? roundStatus(recordOf(blobId)?.status, facts.turn, true)
          : "queued";
        fire(blobId, { type: "dispatched", facts: { ...facts, turn } });
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

/** A service with no app behind it: every round reads as empty, nothing is
 *  recorded or kept. For editors built without the app (tests,
 *  schema-only contexts). */
export function inertPromptWidgets(): PromptWidgetsApi {
  return createPromptWidgets({
    observeRound: () => ({
      get: () => ({
        turn: undefined,
        task: undefined,
        taskTurns: [],
        hasPendingPermission: false,
      }),
      destroy() {},
    }),
    observeStoredRound: () => ({ get: () => undefined, destroy() {} }),
    announceRound() {},
    reviewRanges: NO_SAVED_REVIEW_RANGES,
  });
}
