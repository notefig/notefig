/**
 * The usage time series from React: live totals over a time range.
 */
import { useMemo } from "react";
import { and, gte, lt, useLiveQuery } from "@tanstack/react-db";
import { useCore } from "@notefig/core/react";
import { startOfHour, totalsOf, type UsageTotals } from "./usage";

/** Totals of the hourly buckets overlapping [from, to), live. Hours are
 *  UTC, so a range starting mid-hour (a local midnight in a half-hour
 *  zone) includes that whole hour. */
export function useUsageTotals({
  from,
  to,
}: {
  from: number;
  to: number;
}): UsageTotals {
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
  return useMemo(() => totalsOf(data), [data]);
}
