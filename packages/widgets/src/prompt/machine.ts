/**
 * The prompt widget's state machine — pure, no React, no collections.
 *
 * Every widget is in exactly one of five states. The agent's side of a
 * round arrives as `RoundFacts` (the bound turn's status, whether the task
 * waits on a sign-in or a permission, whether the agent's answer asks the
 * user something), and `stateFromRound` is the one
 * place those facts become a state. Everything that behaves differently per
 * state — the keys, the document's deletion rules, Escape, the face's chrome
 * — asks `capabilitiesOf`, never the state's name, so a new kind of "the
 * agent waits on you" (a question, a tool permission) is a new `Ask`, not a
 * new branch in every consumer.
 */
import type { AgentTurn } from "@notefig/shared/agent";
import type { BlobPhase } from "./state";

/** What the agent is waiting on the user for. */
export type Ask =
  | { kind: "permission" }
  | { kind: "auth" }
  /** The round ended on a question (a `widget_respond` kind that awaits a
   *  reply); the field takes the answer. */
  | { kind: "question" };

export type WidgetState =
  /** Writing a prompt; `confirmingTrust` while the workspace trust warning
   *  waits for a second Send. */
  | { name: "composing"; confirmingTrust: boolean }
  /** Send pressed; the session is resolving and the turn doesn't exist yet. */
  | { name: "sending" }
  /** The agent has a live turn. */
  | { name: "working"; turn: "queued" | "running" }
  /** The agent waits on the user. */
  | { name: "asking"; ask: Ask }
  /** The round is over; the reply field is open. */
  | { name: "settled"; outcome: "done" | "error" | "cancelled" };

/** The agent's side of a bound round, read off its rows. */
export type RoundFacts = {
  /** The bound turn's status; undefined when its row is gone (app restart,
   *  a withdrawn or forgotten turn). */
  turn: AgentTurn["status"] | undefined;
  authRequired: boolean;
  pendingPermission: boolean;
  /** The completed round's response waits on the user's reply. */
  awaitingReply: boolean;
};

export type WidgetEvent =
  | { type: "trustAsked" }
  | { type: "trustAnswered" }
  | { type: "sendStarted" }
  | { type: "sendFailed" }
  /** The send produced a turn; leaves `sending` for whatever it is now. */
  | { type: "dispatched"; facts: RoundFacts }
  /** The bound round's rows changed. */
  | { type: "roundChanged"; facts: RoundFacts }
  /** The widget no longer watches a round (Edit, dismiss, a stale turn). */
  | { type: "unbound" };

export const COMPOSING: WidgetState = {
  name: "composing",
  confirmingTrust: false,
};

/** The state a round's facts add up to. Sign-in outranks the turn's own
 *  status: an auth block holds the prompt whether the turn is queued behind
 *  it or errored out on it. */
export function stateFromRound(facts: RoundFacts): WidgetState {
  const { turn } = facts;
  if (!turn) return COMPOSING;
  if (facts.authRequired && turn !== "completed") {
    return { name: "asking", ask: { kind: "auth" } };
  }
  switch (turn) {
    case "queued":
      return { name: "working", turn: "queued" };
    case "running":
      return facts.pendingPermission
        ? { name: "asking", ask: { kind: "permission" } }
        : { name: "working", turn: "running" };
    case "error":
      return { name: "settled", outcome: "error" };
    case "completed":
      return facts.awaitingReply
        ? { name: "asking", ask: { kind: "question" } }
        : { name: "settled", outcome: "done" };
    case "cancelled":
      return { name: "settled", outcome: "cancelled" };
  }
}

/** What each event does; an event that doesn't apply returns `state`. */
const HANDLERS: {
  [Type in WidgetEvent["type"]]: (
    state: WidgetState,
    event: Extract<WidgetEvent, { type: Type }>,
  ) => WidgetState;
} = {
  trustAsked: (state) =>
    state.name === "composing" && !state.confirmingTrust
      ? { name: "composing", confirmingTrust: true }
      : state,
  trustAnswered: (state) =>
    state.name === "composing" && state.confirmingTrust ? COMPOSING : state,
  // A send leaves from wherever the field takes typing: a prompt, a reply,
  // an answer.
  sendStarted: (state) =>
    capabilitiesOf(state, { summoned: false }).fieldEditable
      ? { name: "sending" }
      : state,
  sendFailed: (state) => (state.name === "sending" ? COMPOSING : state),
  dispatched: (state, event) =>
    state.name === "sending" ? stateFromRound(event.facts) : state,
  // While sending, the round being watched is the previous one (a reply is
  // in flight); the dispatch result decides what comes next.
  roundChanged: (state, event) =>
    state.name === "sending" ? state : stateFromRound(event.facts),
  unbound: () => COMPOSING,
};

/** The next state. An event that doesn't apply to the current state leaves
 *  it unchanged (and returns the same object, so subscribers can skip). */
export function transition(
  state: WidgetState,
  event: WidgetEvent,
): WidgetState {
  const handler = HANDLERS[event.type] as (
    state: WidgetState,
    event: WidgetEvent,
  ) => WidgetState;
  return same(state, handler(state, event));
}

/** Keep the old object when nothing changed. */
function same(previous: WidgetState, next: WidgetState): WidgetState {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * What a widget in this state allows. The only thing behaviour reads.
 *
 * - `fieldEditable`: the draft takes typing — composing a prompt, a reply
 *   after a settled round, or the answer to the agent's question.
 * - `removable`: no live turn depends on the widget, so an edit may delete
 *   it. A sign-in hold isn't live: nothing runs until the user signs in.
 * - `escape`: what Escape does — turn a fresh "/" summon back into a slash,
 *   stop the agent, or hand the caret back to the document.
 */
export type WidgetCapabilities = {
  fieldEditable: boolean;
  removable: boolean;
  escape: "revert" | "stop" | "leave";
};

export function capabilitiesOf(
  state: WidgetState,
  options: { summoned: boolean },
): WidgetCapabilities {
  switch (state.name) {
    case "composing":
      return {
        fieldEditable: true,
        removable: true,
        escape: options.summoned ? "revert" : "leave",
      };
    case "sending":
      return { fieldEditable: false, removable: false, escape: "leave" };
    case "working":
      return { fieldEditable: false, removable: false, escape: "stop" };
    case "asking":
      switch (state.ask.kind) {
        case "auth":
          return { fieldEditable: false, removable: true, escape: "leave" };
        case "permission":
          return { fieldEditable: false, removable: false, escape: "stop" };
        // The turn is over; only the answer is missing.
        case "question":
          return { fieldEditable: true, removable: true, escape: "leave" };
      }
    case "settled":
      return { fieldEditable: true, removable: true, escape: "leave" };
  }
}

/** The face's rendering vocabulary for a state. */
export function phaseOf(state: WidgetState): BlobPhase {
  switch (state.name) {
    case "composing":
      return "composing";
    case "sending":
      return "sending";
    case "working":
      return state.turn;
    case "asking":
      return ASK_PHASES[state.ask.kind];
    case "settled":
      return state.outcome === "error" ? "error" : "done";
  }
}

const ASK_PHASES: Record<Ask["kind"], BlobPhase> = {
  permission: "needs-permission",
  auth: "needs-auth",
  question: "needs-answer",
};
