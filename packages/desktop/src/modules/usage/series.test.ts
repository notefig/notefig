import { afterEach, describe, it, expect } from "vitest";
import { emptySummary, type TurnUsage } from "@notefig/shared/agent";
import {
  periodStart,
  usagePattern,
  usageSeries,
  weekdayTokens,
  type UsageBucket,
} from "@/modules/usage";

// Local times, so the tests hold in any whole-hour timezone: a local hour
// start is then also a UTC hour start, which is what a bucket's `hour` is.
const at = (month: number, day: number, hour = 0) =>
  new Date(2026, month, day, hour).getTime();

function turn(input: number, cost: number | null, model: string | null = "m"): TurnUsage {
  const total = {
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0, thought: 0 },
    cost: cost === null ? null : { amount: cost, currency: "USD", type: "currency" as const },
  };
  return { total, byModel: [{ model, usage: total }] };
}

function bucket(
  hour: number,
  usage: TurnUsage,
  { harnessId = "claude", turns = 1 }: { harnessId?: string; turns?: number } = {},
): UsageBucket {
  return {
    ...emptySummary(),
    ...usage,
    turns,
    bucketId: `usg_${hour}_${harnessId}`,
    hour,
    harnessId,
    workspacePath: "/ws",
  };
}

describe("periodStart", () => {
  it("finds the local day, month and quarter", () => {
    const t = at(7, 20, 15); // Aug 20, 15:00
    expect(periodStart(t, "day")).toBe(at(7, 20));
    expect(periodStart(t, "week")).toBe(at(7, 17)); // Monday
    expect(periodStart(at(7, 23), "week")).toBe(at(7, 17)); // from a Sunday
    expect(periodStart(t, "month")).toBe(at(7, 1));
    expect(periodStart(t, "quarter")).toBe(at(6, 1));
  });
});

describe("usageSeries", () => {
  it("totals money only; a harness's credits stay in its group", () => {
    const credits = { amount: 4, currency: "devin-credit", type: "credits" as const };
    const credited = turn(100, null);
    credited.total = { ...credited.total, cost: credits };
    // Saved before costs were typed: money.
    const legacy = bucket(at(9, 1, 10), turn(10, 0.1));
    delete (legacy.total.cost as { type?: unknown }).type;
    const series = usageSeries(
      [legacy, bucket(at(9, 1, 11), credited, { harnessId: "devin" })],
      { from: at(9, 1), to: at(9, 2), grain: "day", groupBy: "harness" },
    );
    const [day] = series.points;
    expect(day.total.cost?.amount).toBe(0.1);
    expect(day.total.cost?.currency).toBe("USD");
    expect(day.groups.map((g) => [g.key, g.usage.cost?.amount, g.usage.cost?.currency])).toEqual([
      ["devin", 4, "devin-credit"],
      ["claude", 0.1, "USD"],
    ]);
  });

  it("adds hours into local days, gaps included, split by harness", () => {
    const series = usageSeries(
      [
        bucket(at(9, 1, 9), turn(10, 0.1)),
        bucket(at(9, 1, 17), turn(5, 0.2), { turns: 2 }),
        bucket(at(9, 1, 17), turn(100, null), { harnessId: "devin" }),
        bucket(at(9, 3, 8), turn(1, 0.05)),
      ],
      { from: at(9, 1), to: at(9, 4), grain: "day", groupBy: "harness" },
    );

    expect(series.points.map((point) => point.start)).toEqual([
      at(9, 1),
      at(9, 2),
      at(9, 3),
    ]);
    expect(series.keys).toEqual(["devin", "claude"]);

    const [first, empty, third] = series.points;
    expect(first.turns).toBe(4);
    expect(first.total.tokens.input).toBe(115);
    expect(first.total.cost?.amount).toBeCloseTo(0.3);
    expect(first.groups.map((g) => [g.key, g.usage.tokens.input])).toEqual([
      ["devin", 100],
      ["claude", 15],
    ]);
    expect(first.groups[0].usage.cost).toBeNull();
    expect(empty.turns).toBe(0);
    expect(empty.groups).toEqual([]);
    expect(third.groups.map((g) => g.key)).toEqual(["claude"]);
  });

  it("splits by model, an unnamed model as null", () => {
    const series = usageSeries(
      [
        bucket(at(9, 1, 9), {
          total: turn(30, null).total,
          byModel: [turn(20, null, "big").byModel[0], turn(10, null, null).byModel[0]],
        }),
        bucket(at(9, 1, 10), turn(5, null, "big")),
      ],
      { from: at(9, 1), to: at(9, 2), grain: "day", groupBy: "model" },
    );
    expect(series.keys).toEqual(["big", null]);
    expect(series.points[0].groups.map((g) => [g.key, g.usage.tokens.input])).toEqual([
      ["big", 25],
      [null, 10],
    ]);
  });

  it("keeps to one harness when asked", () => {
    const series = usageSeries(
      [
        bucket(at(9, 1, 9), turn(10, null, "a")),
        bucket(at(9, 1, 9), turn(99, null, "b"), { harnessId: "devin" }),
      ],
      { from: at(9, 1), to: at(9, 2), harnessId: "claude", grain: "day", groupBy: "model" },
    );
    expect(series.keys).toEqual(["a"]);
    expect(series.points[0].total.tokens.input).toBe(10);
  });

  it("adds days into Monday-started weeks", () => {
    const series = usageSeries(
      [bucket(at(9, 4, 9), turn(1, null)), bucket(at(9, 5, 9), turn(2, null))],
      { from: at(9, 1), to: at(9, 13), grain: "week", groupBy: "harness" },
    );
    // Oct 1 2026 is a Thursday: its week starts Monday Sep 28.
    expect(series.points.map((p) => [p.start, p.total.tokens.input])).toEqual([
      [at(8, 28), 1],
      [at(9, 5), 2],
      [at(9, 12), 0],
    ]);
  });

  it("groups by month and quarter, and leaves out buckets outside the range", () => {
    const buckets = [
      bucket(at(5, 30, 12), turn(1, null)), // June: before the range
      bucket(at(6, 2, 12), turn(2, null)),
      bucket(at(7, 31, 23), turn(4, null)),
      bucket(at(9, 1, 0), turn(8, null)),
      bucket(at(11, 31, 0), turn(16, null)), // past `to`
    ];
    const range = { from: at(6, 1), to: at(11, 1), groupBy: "harness" } as const;

    const months = usageSeries(buckets, { ...range, grain: "month" });
    expect(months.points.map((p) => [p.start, p.total.tokens.input])).toEqual([
      [at(6, 1), 2],
      [at(7, 1), 4],
      [at(8, 1), 0],
      [at(9, 1), 8],
      [at(10, 1), 0],
    ]);

    const quarters = usageSeries(buckets, { ...range, grain: "quarter" });
    expect(quarters.points.map((p) => [p.start, p.total.tokens.input])).toEqual([
      [at(6, 1), 6],
      [at(9, 1), 8],
    ]);
  });
});

describe("usageSeries in a half-hour zone", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("counts the UTC hour that straddles the range's first midnight", () => {
    process.env.TZ = "Asia/Kolkata"; // UTC+5:30
    const from = new Date(2026, 9, 6).getTime(); // local midnight, 18:30 UTC
    const firstHour = Math.floor(from / 3_600_000) * 3_600_000; // 23:30 local, Oct 5
    expect(firstHour).toBe(from - 1_800_000); // the zone took effect
    const series = usageSeries([bucket(firstHour, turn(7, null))], {
      from,
      to: new Date(2026, 9, 7).getTime(),
      grain: "day",
      groupBy: "harness",
    });
    expect(series.points).toHaveLength(1);
    expect(series.points[0].total.tokens.input).toBe(7);
  });
});

describe("usagePattern", () => {
  it("averages each local hour of day over the range's days", () => {
    const pattern = usagePattern(
      [
        bucket(at(9, 1, 9), turn(70, 0.7)),
        bucket(at(9, 4, 9), turn(70, 0.7), { harnessId: "devin" }),
        bucket(at(9, 6, 22), turn(14, null)),
        bucket(at(8, 30, 9), turn(1_000, null)), // before the range
      ],
      { from: at(9, 1), to: at(9, 8), groupBy: "harness" },
    );

    expect(pattern.hours).toHaveLength(24);
    expect(pattern.hours[9].total.tokens.input).toBe(20);
    expect(pattern.hours[9].total.cost?.amount).toBeCloseTo(0.2);
    expect(pattern.hours[9].turns).toBeCloseTo(2 / 7);
    expect(pattern.hours[9].groups.map((g) => [g.key, g.usage.tokens.input])).toEqual([
      ["claude", 10],
      ["devin", 10],
    ]);
    expect(pattern.hours[22].total.tokens.input).toBe(2);
    expect(pattern.hours[0].turns).toBe(0);
  });
});

describe("weekdayTokens", () => {
  it("adds each local weekday's tokens per harness, Monday first, the largest first", () => {
    // 2026-10-05 is a Monday; the 11th the Sunday after.
    const harnesses = weekdayTokens(
      [
        bucket(at(9, 5, 9), turn(10, null)),
        bucket(at(9, 5, 15), turn(5, null)),
        bucket(at(9, 11, 23), turn(7, null)),
        bucket(at(9, 6, 9), turn(100, null), { harnessId: "devin" }),
        bucket(at(9, 12, 9), turn(1, null)),
      ],
      { from: at(9, 5), to: at(9, 12) },
    );
    expect(
      harnesses.map(({ harnessId, days }) => [harnessId, days.map((tokens) => tokens.input)]),
    ).toEqual([
      ["devin", [0, 100, 0, 0, 0, 0, 0]],
      ["claude", [15, 0, 0, 0, 0, 0, 7]],
    ]);
  });

  it("keeps to one harness when asked", () => {
    const harnesses = weekdayTokens(
      [bucket(at(9, 5, 9), turn(10, null)), bucket(at(9, 6, 9), turn(100, null), { harnessId: "devin" })],
      { from: at(9, 5), to: at(9, 12), harnessId: "claude" },
    );
    expect(harnesses.map((h) => h.harnessId)).toEqual(["claude"]);
  });
});
