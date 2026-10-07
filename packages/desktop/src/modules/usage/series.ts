/**
 * Views over the hourly buckets: usage per day, week, month or quarter, and the
 * average day hour by hour — each split by harness or by model.
 *
 * Buckets cover UTC hours, so every view groups them into the user's local
 * periods here, at read time; nothing coarser is stored, so a change of
 * timezone never leaves days cut at the old one. (In a zone offset by a
 * half hour, a bucket lands in the local hour it starts in.)
 *
 * Both views are one pass over the buckets into mutable accumulators, with
 * each distinct hour's local period worked out once — the per-step
 * allocation of `addSummary` and a `Date` per bucket are what would make
 * a long range slow.
 */
import {
  emptyTokens,
  totalTokens,
  costType,
  type Cost,
  type TokenCounts,
  type Usage,
} from "@notefig/shared/agent";
import { startOfHour, type UsageBucket } from "./usage";

export type UsageGrain = "day" | "week" | "month" | "quarter";

/** What a view splits its totals by. */
export type UsageGroupBy = "harness" | "model";

/** One group's share: a harness id, or a model as the harness named it
 *  (null when it didn't). */
export type UsageGroup = { key: string | null; usage: Usage };

/** A slice of usage and how it splits; groups follow the view's `keys`
 *  order, and only groups with usage in the slice are listed. The total's
 *  cost is money only; a group's is in its harness's unit (Devin credits). */
export type UsageSlice = { total: Usage; turns: number; groups: UsageGroup[] };

export type UsagePoint = UsageSlice & {
  /** Local start of the period (epoch ms). */
  start: number;
};

export type UsageSeries = {
  /** Every period in the range, oldest first — empty ones included, so a
   *  chart's axis has no gaps. */
  points: UsagePoint[];
  /** Every group in the range, most tokens first: one order for stacking
   *  and legends. */
  keys: (string | null)[];
};

export type UsageHourOfDay = UsageSlice & {
  /** Local hour of day, 0–23. */
  hour: number;
};

export type UsagePattern = {
  /** All 24 hours. Each is the range's usage in that hour divided by the
   *  range's length in days — an average day, so turns and tokens can be
   *  fractional. */
  hours: UsageHourOfDay[];
  keys: (string | null)[];
};

const DAY_MS = 24 * 3_600_000;

type Accumulator = {
  tokens: TokenCounts;
  cost: Cost | null;
  turns: number;
};

type SliceAccumulator = {
  total: Accumulator;
  groups: Map<string | null, Accumulator>;
};

function emptyAccumulator(): Accumulator {
  return { tokens: emptyTokens(), cost: null, turns: 0 };
}

function emptySlice(): SliceAccumulator {
  return { total: emptyAccumulator(), groups: new Map() };
}

/** `addUsage`, in place. */
function accumulate(into: Accumulator, usage: Usage, turns: number): void {
  const { tokens } = into;
  tokens.input += usage.tokens.input;
  tokens.cacheRead += usage.tokens.cacheRead;
  tokens.cacheWrite += usage.tokens.cacheWrite;
  tokens.output += usage.tokens.output;
  tokens.thought += usage.tokens.thought;
  into.turns += turns;
  const cost = usage.cost;
  if (!cost) return;
  if (!into.cost) into.cost = { ...cost };
  else if (into.cost.currency === cost.currency) into.cost.amount += cost.amount;
  else {
    // Same rule as `addUsage`: one harness reports in one currency.
    console.warn(
      `[usage] dropping ${cost.amount} ${cost.currency}: series is in ${into.cost.currency}`,
    );
  }
}

/** A slice's total spans harnesses, so its cost is money only: credits are
 *  a harness's own unit and stay in that harness's group. */
function moneyOnly(usage: Usage): Usage {
  return usage.cost && costType(usage.cost) !== "currency"
    ? { ...usage, cost: null }
    : usage;
}

function addBucket(
  slice: SliceAccumulator,
  bucket: UsageBucket,
  groupBy: UsageGroupBy,
): void {
  accumulate(slice.total, moneyOnly(bucket.total), bucket.turns);
  const groupOf = (key: string | null) => {
    let group = slice.groups.get(key);
    if (!group) slice.groups.set(key, (group = emptyAccumulator()));
    return group;
  };
  if (groupBy === "harness") {
    accumulate(groupOf(bucket.harnessId), bucket.total, bucket.turns);
  } else {
    for (const row of bucket.byModel) accumulate(groupOf(row.model), row.usage, 0);
  }
}

function toUsage(acc: Accumulator, divisor: number): Usage {
  const t = acc.tokens;
  return {
    tokens: {
      input: t.input / divisor,
      cacheRead: t.cacheRead / divisor,
      cacheWrite: t.cacheWrite / divisor,
      output: t.output / divisor,
      thought: t.thought / divisor,
    },
    cost: acc.cost && { ...acc.cost, amount: acc.cost.amount / divisor },
  };
}

/** Group keys by tokens over the whole range, largest first. */
function rankKeys(slices: readonly SliceAccumulator[]): (string | null)[] {
  const totals = new Map<string | null, number>();
  for (const slice of slices) {
    for (const [key, acc] of slice.groups) {
      totals.set(key, (totals.get(key) ?? 0) + totalTokens(acc.tokens));
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

function toSlice(
  slice: SliceAccumulator,
  keys: readonly (string | null)[],
  divisor = 1,
): UsageSlice {
  const groups: UsageGroup[] = [];
  for (const key of keys) {
    const acc = slice.groups.get(key);
    if (acc) groups.push({ key, usage: toUsage(acc, divisor) });
  }
  return {
    total: toUsage(slice.total, divisor),
    turns: slice.total.turns / divisor,
    groups,
  };
}

/** Local start of the period `at` falls in. Weeks start on Monday. */
export function periodStart(at: number, grain: UsageGrain): number {
  const d = new Date(at);
  if (grain === "day") {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (grain === "week") {
    const sinceMonday = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
  }
  const month = grain === "month" ? d.getMonth() : d.getMonth() - (d.getMonth() % 3);
  return new Date(d.getFullYear(), month, 1).getTime();
}

/** Local start of the period after the one starting at `start`. */
function nextPeriod(start: number, grain: UsageGrain): number {
  const d = new Date(start);
  if (grain === "day" || grain === "week") {
    const days = grain === "day" ? 1 : 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth() + (grain === "month" ? 1 : 3), 1).getTime();
}

/** Which buckets a view reads: those in [from, to), and of one harness
 *  when `harnessId` is given. */
export type UsageScope = { from: number; to: number; harnessId?: string };

function inScope(bucket: UsageBucket, firstHour: number, scope: UsageScope): boolean {
  return (
    bucket.hour >= firstHour &&
    bucket.hour < scope.to &&
    (scope.harnessId === undefined || bucket.harnessId === scope.harnessId)
  );
}

/** Usage per local period over [from, to), split by harness or model. */
export function usageSeries(
  buckets: readonly UsageBucket[],
  scope: UsageScope & { grain: UsageGrain; groupBy: UsageGroupBy },
): UsageSeries {
  const { from, to, grain, groupBy } = scope;
  const starts: number[] = [];
  const slices: SliceAccumulator[] = [];
  const slotOf = new Map<number, SliceAccumulator>();
  for (let start = periodStart(from, grain); start < to; start = nextPeriod(start, grain)) {
    const slice = emptySlice();
    starts.push(start);
    slices.push(slice);
    slotOf.set(start, slice);
  }

  // Buckets come several to an hour (one per harness × workspace).
  const startOfBucketHour = new Map<number, number>();
  const firstHour = startOfHour(from);
  for (const bucket of buckets) {
    if (!inScope(bucket, firstHour, scope)) continue;
    let start = startOfBucketHour.get(bucket.hour);
    if (start === undefined) {
      start = periodStart(bucket.hour, grain);
      startOfBucketHour.set(bucket.hour, start);
    }
    // In a half-hour zone the range's first UTC hour starts before its
    // first local period; it overlaps that period, so it counts there.
    const slice = slotOf.get(start) ?? (start < starts[0] ? slices[0] : undefined);
    if (slice) addBucket(slice, bucket, groupBy);
  }

  const keys = rankKeys(slices);
  return {
    points: slices.map((slice, index) => ({ start: starts[index], ...toSlice(slice, keys) })),
    keys,
  };
}

/** The average day over [from, to): usage per local hour of day, divided by
 *  the range's length in days — "when do I use agents" over, say, the last
 *  seven days. */
export function usagePattern(
  buckets: readonly UsageBucket[],
  scope: UsageScope & { groupBy: UsageGroupBy },
): UsagePattern {
  const { from, to, groupBy } = scope;
  const slices = Array.from({ length: 24 }, emptySlice);
  const hourOfDay = new Map<number, number>();
  const firstHour = startOfHour(from);
  for (const bucket of buckets) {
    if (!inScope(bucket, firstHour, scope)) continue;
    let hour = hourOfDay.get(bucket.hour);
    if (hour === undefined) {
      hour = new Date(bucket.hour).getHours();
      hourOfDay.set(bucket.hour, hour);
    }
    addBucket(slices[hour], bucket, groupBy);
  }

  const days = Math.max(1, (to - from) / DAY_MS);
  const keys = rankKeys(slices);
  return {
    hours: slices.map((slice, hour) => ({ hour, ...toSlice(slice, keys, days) })),
    keys,
  };
}
