import { describe, it, expect, beforeEach } from "vitest";
import { createHooks, type CoreHookMap, type Hooks } from "@notefig/core";
import { idTimestamp, type TurnUsage } from "@notefig/shared/agent";
import { createNodeTestDb } from "@/testing/node-db";
import { createUsage, startOfHour, totalsOf, type UsageApi } from "@/modules/usage";

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
