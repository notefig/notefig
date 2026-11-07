import { describe, expect, it } from "vitest";
import {
  INITIAL_SYNC_STATE,
  SHARED_POLL_MS,
  SOLO_POLL_MS,
  syncCapabilities,
  transition,
  type SyncEvent,
  type SyncMachineState,
} from "./sync-machine";

const run = (...events: SyncEvent[]): SyncMachineState =>
  events.reduce(transition, INITIAL_SYNC_STATE);
const caps = (...events: SyncEvent[]) => syncCapabilities(run(...events));

describe("sync machine", () => {
  it("is off and inert until enabled", () => {
    const off = caps();
    expect(off).toMatchObject({
      active: false,
      commits: false,
      polls: false,
      status: "off",
      leases: false,
    });
    // Nothing but enable moves it.
    expect(run({ type: "step", activity: "pushing" })).toBe(INITIAL_SYNC_STATE);
    expect(run({ type: "peers", present: true })).toBe(INITIAL_SYNC_STATE);
    expect(run({ type: "failed", fault: "offline" })).toBe(INITIAL_SYNC_STATE);
  });

  it("starts at solo: a slow poll, commits, no shared-level behaviour", () => {
    expect(caps({ type: "enable" })).toMatchObject({
      active: true,
      commits: true,
      polls: true,
      pollIntervalMs: SOLO_POLL_MS,
      leases: false,
      presence: false,
      merges: false,
      status: "synced",
    });
  });

  it("shows each step while it runs and settles back to synced", () => {
    const on: SyncEvent = { type: "enable" };
    expect(caps(on, { type: "step", activity: "committing" }).status).toBe(
      "committing",
    );
    expect(caps(on, { type: "step", activity: "pushing" }).status).toBe(
      "pushing",
    );
    expect(caps(on, { type: "step", activity: "fetching" }).status).toBe(
      "pulling",
    );
    expect(
      caps(on, { type: "step", activity: "pushing" }, { type: "settled" })
        .status,
    ).toBe("synced");
  });

  it("goes offline, backs off, and recovers on the next clean step", () => {
    const once = run({ type: "enable" }, { type: "failed", fault: "offline" });
    expect(syncCapabilities(once)).toMatchObject({
      status: "offline",
      polls: true,
      commits: true,
      pollIntervalMs: SOLO_POLL_MS * 2,
    });
    const twice = transition(once, { type: "failed", fault: "offline" });
    expect(syncCapabilities(twice).pollIntervalMs).toBe(SOLO_POLL_MS * 4);
    // A retry in flight still says offline until it lands.
    expect(
      syncCapabilities(transition(twice, { type: "step", activity: "fetching" }))
        .status,
    ).toBe("pulling");
    const back = transition(twice, { type: "settled" });
    expect(syncCapabilities(back)).toMatchObject({
      status: "synced",
      pollIntervalMs: SOLO_POLL_MS,
    });
  });

  it("backs off far longer when throttled", () => {
    const throttled = caps(
      { type: "enable" },
      { type: "failed", fault: "throttled" },
    );
    expect(throttled.status).toBe("throttled");
    expect(throttled.pollIntervalMs).toBeGreaterThanOrEqual(60_000);
  });

  it("stops on an auth error until the user resumes", () => {
    const denied = run(
      { type: "enable" },
      { type: "failed", fault: "auth-error", detail: "401" },
    );
    expect(syncCapabilities(denied)).toMatchObject({
      status: "auth-error",
      commits: false,
      polls: false,
      canResume: true,
      detail: "401",
    });
    // Steps and successes don't clear it…
    const stillDenied = [
      { type: "step", activity: "pushing" } as const,
      { type: "settled" } as const,
    ].reduce(transition, denied);
    expect(syncCapabilities(stillDenied).status).toBe("auth-error");
    // …resume does.
    expect(syncCapabilities(transition(stillDenied, { type: "resume" })).status)
      .toBe("synced");
  });

  it("stops at diverged (the failsafe), which outranks later failures", () => {
    const diverged = run(
      { type: "enable" },
      { type: "diverged", detail: "notes.md changed on both sides" },
      { type: "failed", fault: "offline" },
    );
    expect(syncCapabilities(diverged)).toMatchObject({
      status: "diverged",
      commits: false,
      polls: false,
      canResume: true,
      detail: "notes.md changed on both sides",
    });
    expect(syncCapabilities(transition(diverged, { type: "disable" })).status)
      .toBe("off");
  });

  it("reaches shared only through presence, with the shared capabilities", () => {
    const shared = caps({ type: "enable" }, { type: "peers", present: true });
    expect(shared).toMatchObject({
      leases: true,
      presence: true,
      merges: true,
      pollIntervalMs: SHARED_POLL_MS,
    });
    expect(
      caps(
        { type: "enable" },
        { type: "peers", present: true },
        { type: "peers", present: false },
      ).leases,
    ).toBe(false);
    // A stopped workspace takes no leases even with peers around.
    expect(
      caps(
        { type: "enable" },
        { type: "peers", present: true },
        { type: "diverged", detail: "x" },
      ).leases,
    ).toBe(false);
  });

  it("returns the same state object for events that change nothing", () => {
    const solo = run({ type: "enable" });
    expect(transition(solo, { type: "enable" })).toBe(solo);
    expect(transition(solo, { type: "peers", present: false })).toBe(solo);
  });
});
