/**
 * Settings → Usage: what agents have spent today, from the usage module's
 * hourly time series — overall, per harness and per model — then the same
 * series over time (`UsageOverTime`).
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  totalTokens,
  type Usage,
  type UsageSummary,
} from "@notefig/shared/agent";
import { startOfHour } from "@/modules/usage";
import { useUsageTotals } from "@/modules/usage/react";
import { useHarnessLabels } from "@/hooks/use-harness-selection";
import { formatCost, formatTokens } from "@/utils/usage-format";
import { useClock } from "@/hooks/use-clock";
import { UsageOverTime } from "./usage-over-time";

const HOUR_MS = 3_600_000;



export function UsageSettings() {
  return (
    <div className="space-y-4">
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
  const totals = useUsageTotals(range);
  const labelOf = useHarnessLabels();

  if (totals.all.turns === 0) {
    return <p className="text-sm text-muted-foreground">{t("usageTodayEmpty")}</p>;
  }

  const harnesses = Object.entries(totals.byHarness).sort(
    ([, a], [, b]) => totalTokens(b.total.tokens) - totalTokens(a.total.tokens),
  );
  const models = [...totals.byModel].sort(
    (a, b) => totalTokens(b.usage.tokens) - totalTokens(a.usage.tokens),
  );

  return (
    <div className="space-y-4">
      <TodaySummary summary={totals.all} />

      <UsageTable
        title={t("usageByHarness")}
        rows={harnesses.map(([harnessId, summary]) => ({
          key: harnessId,
          label: labelOf(harnessId),
          turns: summary.turns,
          usage: summary.total,
        }))}
      />
      <UsageTable
        title={t("usageByModel")}
        rows={models.map((row) => ({
          key: row.model ?? "",
          label: row.model ?? t("usageUnknownModel"),
          usage: row.usage,
        }))}
      />
    </div>
  );
}

function TodaySummary({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation();
  const { tokens, cost } = summary.total;
  const stats: [string, string][] = [
    [t("usageTokens"), formatTokens(totalTokens(tokens))],
    [t("usageTurns"), String(summary.turns)],
    ...(cost ? [[t("usageCost"), formatCost(cost)] as [string, string]] : []),
  ];
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{t("usageToday")}</h3>
      <div className="flex gap-6">
        {stats.map(([label, value]) => (
          <div key={label}>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

type UsageRow = { key: string; label: string; turns?: number; usage: Usage };

function UsageTable({ title, rows }: { title: string; rows: UsageRow[] }) {
  const { t } = useTranslation();
  const showTurns = rows.some((row) => row.turns !== undefined);
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <table className="w-full text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1 text-start font-normal" />
            {showTurns && <th className="py-1 text-end font-normal">{t("usageTurns")}</th>}
            <th className="py-1 text-end font-normal">{t("usageInput")}</th>
            <th className="py-1 text-end font-normal">{t("usageCacheRead")}</th>
            <th className="py-1 text-end font-normal">{t("usageCacheWrite")}</th>
            <th className="py-1 text-end font-normal">{t("usageOutput")}</th>
            <th className="py-1 text-end font-normal">{t("usageCost")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border/50 last:border-0">
              <td className="max-w-[12rem] truncate py-1 text-start">{row.label}</td>
              {showTurns && <td className="py-1 text-end">{row.turns ?? ""}</td>}
              <td className="py-1 text-end">{formatTokens(row.usage.tokens.input)}</td>
              <td className="py-1 text-end">{formatTokens(row.usage.tokens.cacheRead)}</td>
              <td className="py-1 text-end">{formatTokens(row.usage.tokens.cacheWrite)}</td>
              <td className="py-1 text-end">
                {formatTokens(row.usage.tokens.output + row.usage.tokens.thought)}
              </td>
              <td className="py-1 text-end">
                {row.usage.cost ? formatCost(row.usage.cost) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
