import { describe, expect, it } from "vitest";
import { FocusArbiter, type FocusIntent } from "../focus-arbiter";

describe("FocusArbiter", () => {
  function createHarness() {
    let now = 1000;
    const focused: FocusIntent[] = [];
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;

    const arbiter = new FocusArbiter({
      now: () => now,
      executeFocus: (intent) => {
        focused.push(intent);
        return true;
      },
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: ((cb) => {
        const id = nextTimerId++;
        timers.set(id, cb);
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: ((id) => {
        timers.delete(id as unknown as number);
      }) as (id: ReturnType<typeof setTimeout>) => void,
      queueMicrotask: () => {},
    });

    return {
      arbiter,
      focused,
      tick(ms: number) {
        now += ms;
      },
      runTimers() {
        const callbacks = Array.from(timers.values());
        timers.clear();
        callbacks.forEach((cb) => cb());
      },
    };
  }

  it("selects highest-priority intent", () => {
    const h = createHarness();

    h.arbiter.request({
      id: "low",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "low",
      priority: 10,
    });
    h.arbiter.request({
      id: "high",
      domain: "palette",
      target: { type: "element", key: "palette-input" },
      reason: "high",
      priority: 90,
    });

    h.arbiter.setActiveEditor("/a.md");
    h.arbiter.flush();

    expect(h.focused[0]?.id).toBe("high");
  });

  it("only allows active editor target for editor intents", () => {
    const h = createHarness();

    h.arbiter.request({
      id: "editor-a",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "tab-focus",
      priority: 70,
    });

    h.arbiter.setActiveEditor("/b.md");
    h.arbiter.flush();

    expect(h.focused).toHaveLength(0);

    h.arbiter.request({
      id: "editor-b",
      domain: "editor",
      target: { type: "editor", filePath: "/b.md" },
      reason: "tab-focus",
      priority: 70,
    });
    h.arbiter.flush();

    expect(h.focused[0]?.id).toBe("editor-b");
  });

  it("respects suppression windows", () => {
    const h = createHarness();

    h.arbiter.suppress("editor", 200);
    h.arbiter.setActiveEditor("/a.md");
    h.arbiter.request({
      id: "editor",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "tab-focus",
      priority: 70,
    });

    h.arbiter.flush();
    expect(h.focused).toHaveLength(0);

    h.tick(250);
    h.arbiter.flush();
    expect(h.focused[0]?.id).toBe("editor");
  });

  it("expires stale intents by TTL", () => {
    const h = createHarness();

    h.arbiter.request({
      id: "stale",
      domain: "misc",
      target: { type: "element", key: "x" },
      reason: "stale",
      priority: 1,
      ttlMs: 50,
    });

    h.tick(100);
    h.arbiter.flush();

    expect(h.focused).toHaveLength(0);
    expect(h.arbiter.getPendingCount()).toBe(0);
  });

  it("blocks lower-priority focus during cooldown and allows higher-priority preemption", () => {
    const h = createHarness();

    h.arbiter.setActiveEditor("/a.md");
    h.arbiter.request({
      id: "editor",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "editor",
      priority: 70,
    });
    h.arbiter.flush();

    h.arbiter.request({
      id: "misc-low",
      domain: "misc",
      target: { type: "element", key: "hint" },
      reason: "low",
      priority: 20,
    });
    h.arbiter.flush();

    expect(h.focused.map((i) => i.id)).toEqual(["editor"]);

    h.runTimers();

    h.arbiter.request({
      id: "modal-high",
      domain: "modal",
      target: { type: "element", key: "dialog" },
      reason: "modal",
      priority: 100,
    });
    h.arbiter.flush();

    expect(h.focused.map((i) => i.id)).toEqual(["editor", "modal-high"]);
  });

  it("retries when-mounted intents and rejects after max attempts", () => {
    let now = 1000;

    const arbiter = new FocusArbiter({
      now: () => now,
      maxMountAttempts: 2,
      executeFocus: () => false,
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: (() => {
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      queueMicrotask: () => {},
    });

    arbiter.request({
      id: "mount",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "mount",
      priority: 70,
      when: "when-mounted",
    });
    arbiter.setActiveEditor("/a.md");

    arbiter.flush();
    now += 1;
    arbiter.flush();

    expect(arbiter.getPendingCount()).toBe(0);
  });

  it("drops non-mounted intents when focus execution fails", () => {
    const arbiter = new FocusArbiter({
      executeFocus: () => false,
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: (() => {
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      queueMicrotask: () => {},
    });

    arbiter.request({
      id: "one-shot",
      domain: "misc",
      target: { type: "element", key: "x" },
      reason: "test",
      priority: 10,
      when: "immediate",
    });

    arbiter.flush();

    expect(arbiter.getPendingCount()).toBe(0);
  });

  it("dispose clears pending intents", () => {
    const arbiter = new FocusArbiter({
      executeFocus: () => true,
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: (() => {
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      queueMicrotask: () => {},
    });

    arbiter.request({
      id: "pending",
      domain: "editor",
      target: { type: "editor", filePath: "/a.md" },
      reason: "test",
      priority: 10,
      when: "next-frame",
    });

    expect(arbiter.getPendingCount()).toBe(1);

    arbiter.dispose();

    expect(arbiter.getPendingCount()).toBe(0);
  });
});
