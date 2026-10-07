import { describe, it, expect, beforeEach } from "vitest";
import { createHooks, type CoreHookMap, type Hooks } from "@notefig/core";
import type { TurnUsage } from "@notefig/shared/agent";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import {
  createUsage,
  startOfHour,
  USAGE_BUCKETS_COLLECTION_ID,
  type UsageApi,
} from "@/modules/usage";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 6, 14, 5);

function turnUsage(input: number, cost: number | null, model = "m"): TurnUsage {
  const total = {
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 1, thought: 0 },
    cost: cost === null ? null : { amount: cost, currency: "USD" },
    credits: null,
  };
  return { total, byModel: [{ model, usage: total }] };
}

function event(
  overrides: Partial<CoreHookMap["agent:usage"]> = {},
): CoreHookMap["agent:usage"] {
  return {
    taskId: "task_1",
    turnId: "trn_1",
    workspacePath: "/ws",
    harnessId: "claude-code",
    at: T0,
    usage: turnUsage(10, 0.1),
    ...overrides,
  };
}

const limits = (utilization: number, resetsAt: number | null = null) => ({
  status: "ok" as const,
  windows: [{ id: "five_hour", utilization, resetsAt, durationMs: null }],
  usingOverage: null,
});

describe("usage", () => {
  let db: NodeTestDb;
  let hooks: Hooks;
  let usage: UsageApi;

  /** A booted usage module over `db`, as the app has it. */
  function boot(): { hooks: Hooks; usage: UsageApi } {
    const hooks = createHooks();
    const usage = createUsage({ persistence: db.get(), hooks });
    usage.track();
    return { hooks, usage };
  }

  beforeEach(() => {
    db = createNodeTestDb();
    ({ hooks, usage } = boot());
  });

  it("folds agent:usage into the turn's hour bucket", async () => {
    hooks.emit("agent:usage", event());
    hooks.emit("agent:usage", event({ turnId: "trn_2", at: T0 + 60_000, usage: turnUsage(5, 0.2) }));
    hooks.emit("agent:usage", event({ turnId: "trn_3", at: T0 + HOUR }));
    await usage.settled();

    const buckets = usage.buckets.toArray.sort((a, b) => a.hour - b.hour);
    expect(buckets).toHaveLength(2);
    const [first] = buckets;
    expect(first.hour).toBe(startOfHour(T0));
    expect(first.bucketId).toMatch(/^usg_/);
    expect(first.turns).toBe(2);
    expect(first.total.tokens.input).toBe(15);
    expect(first.total.cost?.amount).toBeCloseTo(0.3);
  });

  it("keeps harnesses and workspaces in separate buckets", async () => {
    hooks.emit("agent:usage", event());
    hooks.emit("agent:usage", event({ harnessId: "devin", usage: turnUsage(3, null) }));
    hooks.emit("agent:usage", event({ workspacePath: "/other" }));
    await usage.settled();
    expect(usage.buckets.toArray).toHaveLength(3);
  });

  it("loads nothing at boot, and still adds to a stored hour after a relaunch", async () => {
    hooks.emit("agent:usage", event());
    await usage.settled();

    const after = boot();
    expect(after.usage.buckets.toArray).toEqual([]);

    after.hooks.emit("agent:usage", event({ turnId: "trn_2", usage: turnUsage(5, 0.2) }));
    await after.usage.settled();
    const stored = db.storedRows(USAGE_BUCKETS_COLLECTION_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toMatchObject({ turns: 2, hour: startOfHour(T0) });
  });

  it("keeps each harness's newest limits, one row per harness", async () => {
    const report = (taskId: string, harnessId: string, at: number, utilization: number) =>
      hooks.emit("agent:usage-limits", { taskId, harnessId, at, limits: limits(utilization) });
    report("task_1", "claude-code", 2, 0.2);
    report("task_2", "claude-code", 3, 0.5);
    // An older report arriving late doesn't win.
    report("task_1", "claude-code", 1, 0.9);
    report("task_3", "other", 1, 0.1);
    await usage.settled();

    const rows = usage.limits.toArray;
    expect(rows).toHaveLength(2);
    const claude = rows.find((row) => row.harnessId === "claude-code");
    expect(claude?.limitsId).toMatch(/^ulm_/);
    expect(claude?.at).toBe(3);
    expect(claude?.limits.windows[0].utilization).toBe(0.5);
  });

  it("merges one-window reports, drops windows once reset, and keeps them across a relaunch", async () => {
    const window = (id: string, utilization: number, resetsAt: number | null) => ({
      id,
      utilization,
      resetsAt,
      durationMs: null,
    });
    const report = (
      target: Hooks,
      at: number,
      status: "ok" | "warning",
      ...windows: ReturnType<typeof window>[]
    ) =>
      target.emit("agent:usage-limits", {
        taskId: "task_1",
        harnessId: "claude-code",
        at,
        limits: { status, windows, usingOverage: false },
      });
    report(hooks, 10, "ok", window("five_hour", 0.4, 100), window("seven_day", 0.1, 1000));
    report(hooks, 20, "warning", window("seven_day", 0.8, 1000));
    await usage.settled();

    const after = boot();
    await after.usage.limits.preload();
    expect(after.usage.limits.toArray[0].limits).toEqual({
      status: "warning",
      usingOverage: false,
      windows: [window("five_hour", 0.4, 100), window("seven_day", 0.8, 1000)],
    });

    // Past five_hour's reset, a report that leaves it out drops it.
    report(after.hooks, 200, "ok", window("seven_day", 0.85, 1000));
    await after.usage.settled();
    expect(after.usage.limits.toArray[0].limits.windows).toEqual([window("seven_day", 0.85, 1000)]);
  });
});
