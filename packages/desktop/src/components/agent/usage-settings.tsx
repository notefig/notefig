/**
 * Settings → Usage: what agents have spent today, from the usage module's
 * hourly time series, then the same series over time (`UsageOverTime`).
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { totalTokens } from "@notefig/shared/agent";
import { startOfHour } from "@/modules/usage";
import { useUsageTotals } from "@/modules/usage/react";
import { formatCost, formatTokens } from "@/utils/usage-format";
import { useClock } from "@/hooks/use-clock";
import { UsageOverTime } from "./usage-over-time";

const HOUR_MS = 3_600_000;

export function UsageSettings() {
  return (
    <div className="space-y-6">
      <UsageToday />
      <UsageOverTime />
    </div>
  );
}

function UsageToday() {
  const { t } = useTranslation();
  // Local midnight today to the end of the current hour (so the live bucket
  // is included), moving on so a section left open keeps up. The clock is
  // by the minute — a UTC-hour floor would read 23:30 yesterday at 00:10
  // in a half-hour zone — but the range only changes at an hour.
  const now = new Date(useClock(60_000));
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = startOfHour(now.getTime()) + HOUR_MS;
  const range = useMemo(() => ({ from, to }), [from, to]);
  const { all } = useUsageTotals(range);

  if (all.turns === 0) {
    return <p className="text-sm text-muted-foreground">{t("usageTodayEmpty")}</p>;
  }

  const { tokens, cost } = all.total;
  const stats: [string, string][] = [
    [t("usageTokens"), formatTokens(totalTokens(tokens))],
    [t("usageTurns"), String(all.turns)],
    ...(cost ? [[t("usageCost"), formatCost(cost)] as [string, string]] : []),
  ];
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{t("usageToday")}</h3>
      <div className="flex gap-6">
        {stats.map(([label, value]) => (
          <div key={label}>
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
