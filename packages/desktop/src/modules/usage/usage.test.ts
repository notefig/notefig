import { describe, it, expect, beforeEach } from "vitest";
import { createHooks, type CoreHookMap, type Hooks } from "@notefig/core";
import { idTimestamp, type TurnUsage } from "@notefig/shared/agent";
import { createNodeTestDb } from "@/testing/node-db";
import {
  createUsage,
  startOfHour,
  totalsOf,
  USAGE_BUCKETS_COLLECTION_ID,
  type UsageApi,
} from "@/modules/usage";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 6, 14, 5);

function turnUsage(input: number, cost: number | null, model = "m"): TurnUsage {
  const total = {
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 1, thought: 0 },
    cost: cost === null ? null : { amount: cost, currency: "USD" },
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

describe("usage", () => {
  let hooks: Hooks;
  let usage: UsageApi;

  beforeEach(() => {
    hooks = createHooks();
    usage = createUsage({ persistence: createNodeTestDb().get(), hooks });
  });

  it("folds agent:usage into the turn's hour bucket", async () => {
    const stop = usage.track();
    hooks.emit("agent:usage", event());
    hooks.emit("agent:usage", event({ turnId: "trn_2", at: T0 + 60_000, usage: turnUsage(5, 0.2) }));
    await usage.recordTurn(event({ turnId: "trn_3", at: T0 + HOUR }));
    stop();

    const buckets = usage.buckets.toArray.sort((a, b) => a.hour - b.hour);
    expect(buckets).toHaveLength(2);
    const [first] = buckets;
    expect(first.hour).toBe(startOfHour(T0));
    expect(first.bucketId).toMatch(/^usg_/);
    expect(idTimestamp(first.bucketId)).toBe(first.hour);
    expect(first.turns).toBe(2);
    expect(first.total.tokens.input).toBe(15);
    expect(first.total.cost?.amount).toBeCloseTo(0.3);
  });

  it("keeps harnesses and workspaces in separate buckets", async () => {
    await usage.recordTurn(event());
    await usage.recordTurn(event({ harnessId: "devin", usage: turnUsage(3, null) }));
    await usage.recordTurn(event({ workspacePath: "/other" }));
    expect(usage.buckets.toArray).toHaveLength(3);
  });

  it("loads nothing at boot, and still adds to a stored hour after a relaunch", async () => {
    const db = createNodeTestDb();
    const before = createUsage({ persistence: db.get(), hooks });
    await before.recordTurn(event());

    const after = createUsage({ persistence: db.get(), hooks: createHooks() });
    await Promise.resolve();
    expect(after.buckets.toArray).toEqual([]);

    await after.recordTurn(event({ turnId: "trn_2", usage: turnUsage(5, 0.2) }));
    const stored = db.storedRows(USAGE_BUCKETS_COLLECTION_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toMatchObject({ turns: 2, hour: startOfHour(T0) });
  });

  it("keeps each harness's newest limits, one row per harness", async () => {
    const limits = (utilization: number) => ({
      status: "ok" as const,
      windows: [{ id: "five_hour", utilization, resetsAt: null, durationMs: null }],
      usingOverage: null,
    });
    const stop = usage.track();
    hooks.emit("agent:usage-limits", { taskId: "task_1", harnessId: "claude-code", at: 2, limits: limits(0.2) });
    await usage.recordLimits({ taskId: "task_2", harnessId: "claude-code", at: 3, limits: limits(0.5) });
    // An older report arriving late doesn't win.
    await usage.recordLimits({ taskId: "task_1", harnessId: "claude-code", at: 1, limits: limits(0.9) });
    await usage.recordLimits({ taskId: "task_3", harnessId: "other", at: 1, limits: limits(0.1) });
    stop();

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
    const report = (at: number, status: "ok" | "warning", ...windows: ReturnType<typeof window>[]) => ({
      taskId: "task_1",
      harnessId: "claude-code",
      at,
      limits: { status, windows, usingOverage: false },
    });
    const db = createNodeTestDb();
    const before = createUsage({ persistence: db.get(), hooks });
    await before.recordLimits(report(10, "ok", window("five_hour", 0.4, 100), window("seven_day", 0.1, 1000)));
    await before.recordLimits(report(20, "warning", window("seven_day", 0.8, 1000)));

    const after = createUsage({ persistence: db.get(), hooks: createHooks() });
    await after.limits.preload();
    expect(after.limits.toArray[0].limits).toEqual({
      status: "warning",
      usingOverage: false,
      windows: [window("five_hour", 0.4, 100), window("seven_day", 0.8, 1000)],
    });

    // Past five_hour's reset, a report that leaves it out drops it.
    await after.recordLimits(report(200, "ok", window("seven_day", 0.85, 1000)));
    expect(after.limits.toArray[0].limits.windows).toEqual([window("seven_day", 0.85, 1000)]);
  });

  it("totals buckets overall, per harness and per model", async () => {
    await usage.recordTurn(event({ usage: turnUsage(10, 0.1, "a") }));
    await usage.recordTurn(event({ at: T0 + HOUR, usage: turnUsage(20, 0.2, "b") }));
    await usage.recordTurn(event({ harnessId: "devin", usage: turnUsage(5, null, "a") }));

    const totals = totalsOf(usage.buckets.toArray);
    expect(totals.all.turns).toBe(3);
    expect(totals.all.total.tokens.input).toBe(35);
    expect(totals.byHarness["claude-code"].turns).toBe(2);
    expect(totals.byHarness.devin.total.cost).toBeNull();
    expect(
      totals.byModel.map((row) => [row.model, row.usage.tokens.input]).sort(),
    ).toEqual([
      ["a", 15],
      ["b", 20],
    ]);
  });
});
