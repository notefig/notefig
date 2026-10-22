import { describe, expect, it } from "vitest";
import {
  COMPOSING,
  capabilitiesOf,
  phaseOf,
  stateFromRound,
  transition,
  type RoundFacts,
  type WidgetEvent,
  type WidgetState,
} from "../machine";

const facts = (overrides: Partial<RoundFacts> = {}): RoundFacts => ({
  turn: "running",
  authRequired: false,
  pendingPermission: false,
  ...overrides,
});

const STATES: Record<string, WidgetState> = {
  composing: COMPOSING,
  confirmingTrust: { name: "composing", confirmingTrust: true },
  sending: { name: "sending" },
  queued: { name: "working", turn: "queued" },
  running: { name: "working", turn: "running" },
  permission: { name: "asking", ask: { kind: "permission" } },
  auth: { name: "asking", ask: { kind: "auth" } },
  done: { name: "settled", outcome: "done" },
  error: { name: "settled", outcome: "error" },
  cancelled: { name: "settled", outcome: "cancelled" },
};

describe("stateFromRound", () => {
  it("follows the turn's status", () => {
    expect(stateFromRound(facts({ turn: undefined }))).toEqual(COMPOSING);
    expect(stateFromRound(facts({ turn: "queued" }))).toEqual(STATES.queued);
    expect(stateFromRound(facts({ turn: "running" }))).toEqual(STATES.running);
    expect(stateFromRound(facts({ turn: "completed" }))).toEqual(STATES.done);
    expect(stateFromRound(facts({ turn: "error" }))).toEqual(STATES.error);
    expect(stateFromRound(facts({ turn: "cancelled" }))).toEqual(
      STATES.cancelled,
    );
  });

  it("asks for a permission only while the turn runs", () => {
    expect(stateFromRound(facts({ pendingPermission: true }))).toEqual(
      STATES.permission,
    );
    expect(
      stateFromRound(facts({ turn: "queued", pendingPermission: true })),
    ).toEqual(STATES.queued);
  });

  it("asks for a sign-in over anything but a completed turn", () => {
    for (const turn of ["queued", "running", "error", "cancelled"] as const) {
      expect(stateFromRound(facts({ turn, authRequired: true }))).toEqual(
        STATES.auth,
      );
    }
    expect(
      stateFromRound(facts({ turn: "completed", authRequired: true })),
    ).toEqual(STATES.done);
  });
});

describe("transition", () => {
  const every = (event: WidgetEvent) =>
    Object.fromEntries(
      Object.entries(STATES).map(([name, state]) => [
        name,
        transition(state, event),
      ]),
    );

  it("arms and answers the trust warning only while composing", () => {
    const asked = every({ type: "trustAsked" });
    expect(asked.composing).toEqual(STATES.confirmingTrust);
    expect(asked.confirmingTrust).toBe(STATES.confirmingTrust);
    expect(asked.running).toBe(STATES.running);
    const answered = every({ type: "trustAnswered" });
    expect(answered.confirmingTrust).toEqual(COMPOSING);
    expect(answered.composing).toBe(COMPOSING);
  });

  it("sends from a composer or a settled round, nowhere else", () => {
    const next = every({ type: "sendStarted" });
    for (const name of ["composing", "confirmingTrust", "done", "error", "cancelled"]) {
      expect(next[name]).toEqual(STATES.sending);
    }
    for (const name of ["sending", "queued", "running", "permission", "auth"]) {
      expect(next[name]).toBe(STATES[name]);
    }
  });

  it("leaves sending for the dispatched round, or back to composing", () => {
    expect(
      transition(STATES.sending, {
        type: "dispatched",
        facts: facts({ turn: "queued" }),
      }),
    ).toEqual(STATES.queued);
    expect(transition(STATES.sending, { type: "sendFailed" })).toEqual(
      COMPOSING,
    );
    expect(transition(STATES.done, { type: "sendFailed" })).toBe(STATES.done);
  });

  it("ignores round changes while a send is in flight", () => {
    // A reply's previous round may still settle under it.
    expect(
      transition(STATES.sending, {
        type: "roundChanged",
        facts: facts({ turn: "completed" }),
      }),
    ).toBe(STATES.sending);
  });

  it("follows the round otherwise, keeping the object when nothing moved", () => {
    expect(
      transition(STATES.queued, { type: "roundChanged", facts: facts() }),
    ).toEqual(STATES.running);
    expect(
      transition(STATES.running, { type: "roundChanged", facts: facts() }),
    ).toBe(STATES.running);
  });

  it("unbinding always lands on a fresh composer", () => {
    for (const state of Object.values(STATES)) {
      expect(transition(state, { type: "unbound" })).toEqual(COMPOSING);
    }
  });
});

describe("capabilitiesOf", () => {
  const plain = { summoned: false };

  it("opens the field to a composer and a reply, nothing else", () => {
    const editable = Object.entries(STATES)
      .filter(([, state]) => capabilitiesOf(state, plain).fieldEditable)
      .map(([name]) => name);
    expect(editable).toEqual([
      "composing",
      "confirmingTrust",
      "done",
      "error",
      "cancelled",
    ]);
  });

  it("protects a widget while the agent has a live turn", () => {
    const kept = Object.entries(STATES)
      .filter(([, state]) => !capabilitiesOf(state, plain).removable)
      .map(([name]) => name);
    // A sign-in hold runs nothing until the user signs in.
    expect(kept).toEqual(["sending", "queued", "running", "permission"]);
  });

  it("Escape stops a live turn, reverts a fresh summon, else leaves", () => {
    expect(capabilitiesOf(COMPOSING, { summoned: true }).escape).toBe("revert");
    expect(capabilitiesOf(COMPOSING, plain).escape).toBe("leave");
    for (const name of ["queued", "running", "permission"]) {
      expect(capabilitiesOf(STATES[name], plain).escape).toBe("stop");
    }
    for (const name of ["sending", "auth", "done", "error"]) {
      expect(capabilitiesOf(STATES[name], plain).escape).toBe("leave");
    }
  });
});

describe("phaseOf", () => {
  it("names each state in the face's vocabulary", () => {
    expect(
      Object.fromEntries(
        Object.entries(STATES).map(([name, state]) => [name, phaseOf(state)]),
      ),
    ).toEqual({
      composing: "composing",
      confirmingTrust: "composing",
      sending: "sending",
      queued: "queued",
      running: "running",
      permission: "needs-permission",
      auth: "needs-auth",
      done: "done",
      error: "error",
      cancelled: "done",
    });
  });
});

describe("a round settled on record", () => {
  it("stands in for a turn row that is gone", () => {
    expect(
      stateFromRound(facts({ turn: undefined, settled: "completed" })),
    ).toEqual(STATES.done);
    expect(
      stateFromRound(facts({ turn: undefined, settled: "error" })),
    ).toEqual(STATES.error);
    // A live turn row still wins.
    expect(stateFromRound(facts({ turn: "running", settled: "completed" }))).toEqual(
      STATES.running,
    );
  });
});
