/**
 * The usage time series from React: live views over a time range. Each
 * loads only its range's buckets (the collection syncs on demand) and
 * recomputes when they change — when a turn settles, not on every render.
 */
import { useMemo } from "react";
import { and, gte, lt, useLiveQuery } from "@tanstack/react-db";
import { useCore } from "@notefig/core/react";
import {
  startOfHour,
  type HarnessLimits,
  type UsageBucket,
} from "./usage";
import {
  usagePattern,
  usageSeries,
  type UsageGrain,
  type UsageGroupBy,
  type UsagePattern,
  type UsageScope,
  type UsageSeries,
} from "./series";

type Range = { from: number; to: number };

/** The hourly buckets overlapping [from, to), live. Hours are UTC, so a
 *  range starting mid-hour (a local midnight in a half-hour zone) includes
 *  that whole hour. */
function useBuckets({ from, to }: Range): UsageBucket[] {
  const { buckets } = useCore().usage;
  const firstHour = startOfHour(from);
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ bucket: buckets })
        .where(({ bucket }) =>
          and(gte(bucket.hour, firstHour), lt(bucket.hour, to)),
        ),
    [buckets, firstHour, to],
  );
  return data;
}

/** Every harness's last-reported account limits, live. */
export function useHarnessLimits(): HarnessLimits[] {
  const { limits } = useCore().usage;
  const { data = [] } = useLiveQuery((q) => q.from({ row: limits }), [limits]);
  return data;
}

/** Usage per local day, week, month or quarter over [from, to), split by
 *  harness or model; one harness's only, given `harnessId`. */
export function useUsageSeries({
  from,
  to,
  harnessId,
  grain,
  groupBy,
}: UsageScope & { grain: UsageGrain; groupBy: UsageGroupBy }): UsageSeries {
  const data = useBuckets({ from, to });
  return useMemo(
    () => usageSeries(data, { from, to, harnessId, grain, groupBy }),
    [data, from, to, harnessId, grain, groupBy],
  );
}

/** The average day over [from, to), hour by hour. */
export function useUsagePattern({
  from,
  to,
  harnessId,
  groupBy,
}: UsageScope & { groupBy: UsageGroupBy }): UsagePattern {
  const data = useBuckets({ from, to });
  return useMemo(
    () => usagePattern(data, { from, to, harnessId, groupBy }),
    [data, from, to, harnessId, groupBy],
  );
}
