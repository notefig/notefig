/**
 * Settings → Usage, below today's totals: usage over time by harness, the
 * average day hour by hour, and one harness in detail (its models and its
 * account limits). Everything reads the usage module's hourly buckets for
 * the chosen range; the grouping is `series.ts`'s, done once per change.
 *
 * Charts show the three largest series and fold the rest into "Other", so
 * they stay readable however many harnesses or models there are. A harness
 * that never reports cost or limits is greyed wherever those are asked for.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@notefig/ui/select";
import { cn } from "@notefig/ui/utils";
import {
  totalTokens,
  type UsageLimitStatus,
  type Usage,
} from "@notefig/shared/agent";
import type {
  HarnessLimits,
  UsageGrain,
  UsageSeries,
  UsageSlice,
} from "@/modules/usage";
import {
  useHarnessLimits,
  useUsagePattern,
  useUsageSeries,
} from "@/modules/usage/react";
import { usageReportingOf, type UsageReporting } from "@/modules/agents/usage-reporting";
import { useActiveHarnesses, useHarnessLabels } from "@/hooks/use-harness-selection";
import { useClock } from "@/hooks/use-clock";
import { formatCost, formatTokens } from "@/utils/usage-format";
import { UsageBarChart, type ChartBar, type ChartSeries } from "./usage-bar-chart";

type Metric = "tokens" | "cost";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RANGES = [7, 30, 90, 365] as const;
type RangeDays = (typeof RANGES)[number];

/** Grains that give a range a readable number of bars (≤ ~90). */
const GRAINS: Record<RangeDays, UsageGrain[]> = {
  7: ["day"],
  30: ["day", "week"],
  90: ["day", "week", "month"],
  365: ["week", "month", "quarter"],
};

const PATTERN_DAYS = 7;

/** Series shown before the rest fold into "Other" — four when exactly four. */
const TOP_SERIES = 3;
const PALETTE = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
];
const OTHER_COLOR = "hsl(var(--muted-foreground) / 0.45)";
const OTHER_KEY = "\u0000other";
const NULL_KEY = "\u0000none";

function metricOf(usage: Usage, metric: Metric): number {
  return metric === "cost" ? (usage.cost?.amount ?? 0) : totalTokens(usage.tokens);
}

type ShownSeries = {
  series: ChartSeries[];
  /** Per slice, one value per series. */
  values: number[][];
  /** Per series, over every slice. */
  totals: number[];
};

/** The largest groups as chart series, the rest summed into "Other". */
function topSeries(
  slices: readonly UsageSlice[],
  keys: readonly (string | null)[],
  metric: Metric,
  nameOf: (key: string | null) => string,
  otherName: string,
  include: (key: string | null) => boolean = () => true,
): ShownSeries {
  const totalOf = new Map<string | null, number>();
  for (const slice of slices) {
    for (const group of slice.groups) {
      if (!include(group.key)) continue;
      totalOf.set(group.key, (totalOf.get(group.key) ?? 0) + metricOf(group.usage, metric));
    }
  }
  const ranked = keys
    .filter((key) => (totalOf.get(key) ?? 0) > 0)
    .sort((a, b) => (totalOf.get(b) ?? 0) - (totalOf.get(a) ?? 0));
  const shown = ranked.length <= TOP_SERIES + 1 ? ranked : ranked.slice(0, TOP_SERIES);
  const rest = new Set(ranked.slice(shown.length));

  const series: ChartSeries[] = shown.map((key, index) => ({
    key: key ?? NULL_KEY,
    name: nameOf(key),
    color: PALETTE[index],
  }));
  if (rest.size > 0) series.push({ key: OTHER_KEY, name: otherName, color: OTHER_COLOR });

  const values = slices.map((slice) => {
    const row = shown.map((key) => {
      const group = slice.groups.find((g) => g.key === key);
      return group ? metricOf(group.usage, metric) : 0;
    });
    if (rest.size > 0) {
      row.push(
        slice.groups
          .filter((group) => rest.has(group.key))
          .reduce((sum, group) => sum + metricOf(group.usage, metric), 0),
      );
    }
    return row;
  });
  const totals = series.map((_, index) =>
    values.reduce((sum, row) => sum + row[index], 0),
  );
  return { series, values, totals };
}

function useFormatters(currency: string) {
  return useMemo(() => {
    const compactCost = (() => {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency,
          notation: "compact",
          maximumFractionDigits: 1,
        });
      } catch {
        return null;
      }
    })();
    return {
      value: (metric: Metric) => (value: number) =>
        metric === "cost" ? formatCost({ amount: value, currency }) : formatTokens(value),
      axis: (metric: Metric) => (value: number) =>
        metric === "cost"
          ? (compactCost?.format(value) ?? `${value} ${currency}`)
          : formatTokens(value),
    };
  }, [currency]);
}

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function hourRange(hour: number): string {
  return `${hourLabel(hour)} – ${hourLabel((hour + 1) % 24)}`;
}

/** "5h", "7d": a limit window's length. */
function duration(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms >= HOUR_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/** "2h 14m", "3d 5h": time left until `at`. */
function until(at: number, now: number): string {
  const ms = Math.max(0, at - now);
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
  return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / 60_000)}m`;
}

/** Thin out axis labels to about eight, counted back from the newest bar. */
function everyNth(count: number): (index: number) => boolean {
  const every = Math.max(1, Math.ceil(count / 8));
  return (index) => (count - 1 - index) % every === 0;
}

/** The over-time ranges, moving on with the clock (hourly) so a section
 *  left open keeps taking in new hours, and the next day at midnight. */
function useRanges(rangeDays: RangeDays) {
  const hour = useClock(HOUR_MS);
  const range = useMemo(() => {
    const now = new Date(hour);
    return {
      from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1)).getTime(),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
    };
  }, [rangeDays, hour]);
  const patternRange = useMemo(() => {
    const to = hour + HOUR_MS;
    return { from: to - PATTERN_DAYS * DAY_MS, to };
  }, [hour]);
  return { range, patternRange };
}

/** What the views need to know about harnesses: which to offer, what each
 *  reports, and the currency costs are in. */
function useHarnessFacts(byHarness: UsageSeries, limits: HarnessLimits[]) {
  const activeHarnesses = useActiveHarnesses();
  const costSeen = useMemo(() => {
    const seen = new Set<string>();
    for (const group of byHarness.points.flatMap((point) => point.groups)) {
      if (group.usage.cost && group.key) seen.add(group.key);
    }
    return seen;
  }, [byHarness]);
  // Every live harness, then any that only appear in the data (a removed
  // custom harness) — used ones first.
  const harnessIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of byHarness.keys) if (key) ids.add(key);
    for (const harness of activeHarnesses) ids.add(harness.id);
    for (const row of limits) ids.add(row.harnessId);
    return [...ids];
  }, [byHarness.keys, activeHarnesses, limits]);
  const reportingOf = (harnessId: string): UsageReporting =>
    usageReportingOf(harnessId, {
      cost: costSeen.has(harnessId),
      limits: limits.some((row) => row.harnessId === harnessId),
    });
  const currency =
    byHarness.points.flatMap((point) => point.groups).find((group) => group.usage.cost)
      ?.usage.cost?.currency ?? "USD";
  return { harnessIds, reportingOf, currency };
}

export function UsageOverTime() {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<Metric>("tokens");
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [grainChoice, setGrain] = useState<UsageGrain>("day");
  const grain = GRAINS[rangeDays].includes(grainChoice) ? grainChoice : GRAINS[rangeDays][0];
  const { range, patternRange } = useRanges(rangeDays);

  const byHarness = useUsageSeries({ from: range.from, to: range.to, grain, groupBy: "harness" });
  const pattern = useUsagePattern({ ...patternRange, groupBy: "harness" });
  const limits = useHarnessLimits();
  const labelOf = useHarnessLabels();
  const { harnessIds, reportingOf, currency } = useHarnessFacts(byHarness, limits);
  const formatters = useFormatters(currency);

  const metricName = metric === "cost" ? t("usageCost") : t("usageTokens");
  const rangeName = rangeDays === 365 ? t("usageRangeYear") : t("usageRangeDays", { count: rangeDays });
  const grainName = t(`usageGrain_${grain}`).toLowerCase();
  const shared = {
    metric,
    labelOf,
    reportingOf,
    format: formatters.value(metric),
    formatAxis: formatters.axis(metric),
  };

  return (
    <div className="space-y-4 pt-4" data-testid="usage-over-time">
      <UsageControls
        metric={metric}
        onMetric={setMetric}
        grain={grain}
        onGrain={setGrain}
        rangeDays={rangeDays}
        onRangeDays={setRangeDays}
      />
      <ByHarnessCard
        {...shared}
        points={byHarness.points}
        keys={byHarness.keys}
        grain={grain}
        description={t("usageSeriesDesc", { metric: metricName, grain: grainName, range: rangeName })}
      />
      <PatternCard
        {...shared}
        pattern={pattern}
        description={t("usagePatternDesc", { metric: metricName.toLowerCase(), count: PATTERN_DAYS })}
      />
      <HarnessCard
        metric={metric}
        range={range}
        grain={grain}
        harnessIds={harnessIds}
        labelOf={labelOf}
        reportingOf={reportingOf}
        limits={limits}
        caption={{ grain: grainName, range: rangeName }}
        formatters={formatters}
      />
    </div>
  );
}

function UsageControls({
  metric,
  onMetric,
  grain,
  onGrain,
  rangeDays,
  onRangeDays,
}: {
  metric: Metric;
  onMetric: (metric: Metric) => void;
  grain: UsageGrain;
  onGrain: (grain: UsageGrain) => void;
  rangeDays: RangeDays;
  onRangeDays: (days: RangeDays) => void;
}) {
  const { t } = useTranslation();
  const rangeLabel = (days: RangeDays) =>
    days === 365 ? t("usageRangeYear") : t("usageRangeDays", { count: days });
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium">{t("usageOverTime")}</h3>
        <p className="text-xs text-muted-foreground">{t("usageOverTimeHint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("usageMetric")}
          value={metric}
          onChange={onMetric}
          options={[
            { value: "tokens", label: t("usageTokens") },
            { value: "cost", label: t("usageCost") },
          ]}
        />
        <Segmented
          label={t("usageGrain")}
          value={grain}
          onChange={onGrain}
          options={GRAINS[rangeDays].map((value) => ({ value, label: t(`usageGrain_${value}`) }))}
        />
        <Select
          value={String(rangeDays)}
          onValueChange={(value) => onRangeDays(Number(value) as RangeDays)}
        >
          <SelectTrigger className="h-7 w-36 text-xs" aria-label={t("usageRange")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((days) => (
              <SelectItem key={days} value={String(days)} className="text-xs">
                {rangeLabel(days)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 px-3 text-xs",
            index > 0 && "border-s border-border",
            option.value === value
              ? "bg-foreground text-background"
              : "text-foreground hover:bg-accent",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Card({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="space-y-4 rounded-lg border border-border bg-background p-4" data-testid={testId}>
      {children}
    </div>
  );
}

type Shared = {
  metric: Metric;
  labelOf: (harnessId: string) => string;
  reportingOf: (harnessId: string) => UsageReporting;
  format: (value: number) => string;
  formatAxis: (value: number) => string;
};

function periodLabels(grain: UsageGrain, start: number, weekOf: (date: string) => string) {
  const date = new Date(start);
  if (grain === "quarter") {
    const label = `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
    return { axis: label, title: label };
  }
  if (grain === "month") {
    return {
      axis: date.toLocaleDateString(undefined, { month: "short" }),
      title: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
  }
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return {
    axis: day,
    title:
      grain === "week"
        ? weekOf(day)
        : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
  };
}

/** A series over periods, or a line saying the range is empty. */
function PeriodChart({
  points,
  shown,
  grain,
  ...chart
}: {
  points: (UsageSlice & { start: number })[];
  shown: ShownSeries;
  grain: UsageGrain;
  format: (value: number) => string;
  formatAxis: (value: number) => string;
  height: number;
  overlay?: string;
  testId: string;
}) {
  const { t } = useTranslation();
  if (points.every((point) => point.turns === 0)) {
    return <p className="text-xs text-muted-foreground">{t("usageNoUsageInRange")}</p>;
  }
  return (
    <UsageBarChart
      {...chart}
      series={shown.series}
      bars={seriesBars(points, shown.values, grain, (date) => t("usageWeekOf", { date }))}
    />
  );
}

function seriesBars(
  points: readonly (UsageSlice & { start: number })[],
  values: number[][],
  grain: UsageGrain,
  weekOf: (date: string) => string,
): ChartBar[] {
  const labelled = everyNth(points.length);
  return points.map((point, index) => {
    const labels = periodLabels(grain, point.start, weekOf);
    return {
      key: point.start,
      axisLabel: labelled(index) ? labels.axis : "",
      title: labels.title,
      values: values[index],
    };
  });
}

function ByHarnessCard({
  metric,
  points,
  keys,
  grain,
  description,
  labelOf,
  reportingOf,
  format,
  formatAxis,
}: Shared & {
  points: (UsageSlice & { start: number })[];
  keys: (string | null)[];
  grain: UsageGrain;
  description: string;
}) {
  const { t } = useTranslation();
  const canShow = (key: string | null) => metric !== "cost" || (!!key && reportingOf(key).cost);
  const shown = topSeries(points, keys, metric, (key) => labelOf(key ?? ""), t("usageOther"), canShow);
  const withoutCost =
    metric === "cost" ? keys.filter((key): key is string => !!key && !canShow(key)) : [];

  return (
    <Card testId="usage-by-harness">
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{t("usageByHarness")}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex flex-wrap gap-5">
          {shown.series.map((s, index) => (
            <Legend key={s.key} name={s.name} color={s.color} value={format(shown.totals[index])} />
          ))}
          {withoutCost.map((harnessId) => (
            <Legend
              key={harnessId}
              name={labelOf(harnessId)}
              color={OTHER_COLOR}
              value={t("usageNoCostData")}
              muted
            />
          ))}
        </div>
      </div>
      <PeriodChart
        points={points}
        shown={shown}
        grain={grain}
        format={format}
        formatAxis={formatAxis}
        height={180}
        testId="usage-chart-harness"
      />
    </Card>
  );
}

function Legend({
  name,
  color,
  value,
  muted = false,
}: {
  name: string;
  color: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", muted && "opacity-60")}>
      <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <span className="size-2 rounded-full" style={{ background: color }} />
        {name}
      </div>
      <div className={cn("tabular-nums", muted ? "text-xs" : "text-lg font-semibold")}>{value}</div>
    </div>
  );
}

function PatternCard({
  metric,
  pattern,
  description,
  labelOf,
  reportingOf,
  format,
  formatAxis,
}: Shared & {
  pattern: { hours: (UsageSlice & { hour: number })[]; keys: (string | null)[] };
  description: string;
}) {
  const { t } = useTranslation();
  const canShow = (key: string | null) => metric !== "cost" || (!!key && reportingOf(key).cost);
  const shown = topSeries(pattern.hours, pattern.keys, metric, (key) => labelOf(key ?? ""), t("usageOther"), canShow);
  const sums = shown.values.map((row) => row.reduce((sum, value) => sum + value, 0));
  const peak = sums.some((sum) => sum > 0) ? sums.indexOf(Math.max(...sums)) : null;

  return (
    <Card testId="usage-pattern">
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{t("usageDailyPattern")}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="text-end">
          <div className="text-[0.6875rem] text-muted-foreground">{t("usageBusiestHour")}</div>
          <div className="text-sm font-semibold" data-testid="usage-busiest-hour">
            {peak === null ? "—" : hourRange(peak)}
          </div>
        </div>
      </div>
      {peak === null ? (
        <p className="text-xs text-muted-foreground">{t("usageNoUsageInRange")}</p>
      ) : (
        <UsageBarChart
          series={shown.series}
          bars={pattern.hours.map((slot, index) => ({
            key: slot.hour,
            axisLabel: slot.hour % 3 === 0 ? hourLabel(slot.hour) : "",
            title: hourRange(slot.hour),
            values: shown.values[index],
          }))}
          format={format}
          formatAxis={formatAxis}
          height={110}
          testId="usage-chart-pattern"
        />
      )}
    </Card>
  );
}

function HarnessCard({
  metric,
  range,
  grain,
  harnessIds,
  labelOf,
  reportingOf,
  limits,
  caption,
  formatters,
}: {
  metric: Metric;
  range: { from: number; to: number };
  grain: UsageGrain;
  harnessIds: string[];
  labelOf: (harnessId: string) => string;
  reportingOf: (harnessId: string) => UsageReporting;
  limits: HarnessLimits[];
  /** The range and grain, as the captions name them. */
  caption: { grain: string; range: string };
  formatters: ReturnType<typeof useFormatters>;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const harnessId = chosen && harnessIds.includes(chosen) ? chosen : (harnessIds[0] ?? "");
  const byModel = useUsageSeries({ from: range.from, to: range.to, harnessId, grain, groupBy: "model" });
  const reporting = reportingOf(harnessId);
  const name = labelOf(harnessId);
  // Cost asked of a harness that has none: chart its tokens, greyed.
  const ghost = metric === "cost" && !reporting.cost;
  const shownMetric: Metric = ghost ? "tokens" : metric;
  const format = formatters.value(shownMetric);
  const shown = topSeries(
    byModel.points,
    byModel.keys,
    shownMetric,
    (key) => key ?? t("usageUnknownModel"),
    t("usageOther"),
  );

  return (
    <Card testId="usage-harness-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <HarnessTitle name={name} reporting={reporting} />
        <HarnessPicker
          value={harnessId}
          onChange={setChosen}
          harnessIds={harnessIds}
          labelOf={labelOf}
          reportingOf={reportingOf}
          metric={metric}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <ModelChart
          name={name}
          ghost={ghost}
          metric={shownMetric}
          caption={caption}
          points={byModel.points}
          shown={shown}
          grain={grain}
          format={format}
          formatAxis={formatters.axis(shownMetric)}
        />

        <div className="space-y-4 rounded-md border border-border bg-muted/30 p-3 text-xs">
          <ModelsPanel
            shown={shown}
            format={format}
            unnamedOnly={byModel.keys.length > 0 && byModel.keys.every((key) => key === null)}
            name={name}
          />
          <LimitsPanel
            name={name}
            supported={reporting.limits}
            row={limits.find((row) => row.harnessId === harnessId)}
          />
        </div>
      </div>
    </Card>
  );
}

function HarnessTitle({ name, reporting }: { name: string; reporting: UsageReporting }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{name}</div>
      <div className="flex flex-wrap gap-1">
        <Cap>{reporting.cost ? t("usageCapCost") : t("usageCapTokensOnly")}</Cap>
        <Cap>{reporting.limits ? t("usageCapLimits") : t("usageCapNoLimits")}</Cap>
      </div>
    </div>
  );
}

/** One harness's usage by model; greyed tokens (`ghost`) when the view
 *  asks for a cost it doesn't report. */
function ModelChart({
  name,
  ghost,
  metric,
  caption,
  points,
  shown,
  grain,
  format,
  formatAxis,
}: {
  name: string;
  ghost: boolean;
  metric: Metric;
  caption: { grain: string; range: string };
  points: (UsageSlice & { start: number })[];
  shown: ShownSeries;
  grain: UsageGrain;
  format: (value: number) => string;
  formatAxis: (value: number) => string;
}) {
  const { t } = useTranslation();
  const description = ghost
    ? t("usageDetailNoCost", { name })
    : t("usageDetailDesc", {
        metric: metric === "cost" ? t("usageCost") : t("usageTokens"),
        ...caption,
      });
  return (
    <div className="min-w-0 space-y-2">
      <div className="text-xs text-muted-foreground">{description}</div>
      <PeriodChart
        points={points}
        shown={shown}
        grain={grain}
        format={format}
        formatAxis={formatAxis}
        height={200}
        overlay={ghost ? t("usageNoCostData") : undefined}
        testId="usage-chart-models"
      />
    </div>
  );
}

function HarnessPicker({
  value,
  onChange,
  harnessIds,
  labelOf,
  reportingOf,
  metric,
}: {
  value: string;
  onChange: (harnessId: string) => void;
  harnessIds: string[];
  labelOf: (harnessId: string) => string;
  reportingOf: (harnessId: string) => UsageReporting;
  metric: Metric;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {t("usageHarness")}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-52 text-xs" data-testid="usage-harness-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {harnessIds.map((id) => (
            <HarnessOption
              key={id}
              harnessId={id}
              label={labelOf(id)}
              reporting={reportingOf(id)}
              metric={metric}
            />
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/** A harness's models over the range, with each one's share. */
function ModelsPanel({
  shown,
  format,
  unnamedOnly,
  name,
}: {
  shown: ShownSeries;
  format: (value: number) => string;
  /** The harness names no models at all. */
  unnamedOnly: boolean;
  name: string;
}) {
  const { t } = useTranslation();
  const sum = shown.totals.reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-2">
      <div className="font-medium">{t("usageModels")}</div>
      {shown.series.length === 0 && (
        <div className="text-muted-foreground">{t("usageNoUsageInRange")}</div>
      )}
      {unnamedOnly && (
        <div className="text-muted-foreground">{t("usageNoModelNames", { name })}</div>
      )}
      {shown.series.map((s, index) => {
        const share = sum ? Math.round((shown.totals[index] / sum) * 100) : 0;
        return (
          <div key={s.key} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="font-medium tabular-nums">{format(shown.totals[index])}</span>
              <span className="w-8 text-end tabular-nums text-muted-foreground">{share}%</span>
            </div>
            <Meter fraction={share / 100} color={s.color} />
          </div>
        );
      })}
    </div>
  );
}

/** A harness in the picker: greyed when it lacks what the view is showing
 *  (cost), and labelled with what it never reports. */
function HarnessOption({
  harnessId,
  label,
  reporting,
  metric,
}: {
  harnessId: string;
  label: string;
  reporting: UsageReporting;
  metric: Metric;
}) {
  const { t } = useTranslation();
  const missing = [
    !reporting.cost && t("usageHintNoCost"),
    !reporting.limits && t("usageHintNoLimits"),
  ].filter(Boolean);
  const greyed = (metric === "cost" && !reporting.cost) || missing.length === 2;
  return (
    <SelectItem
      value={harnessId}
      className={cn("text-xs", greyed && "text-muted-foreground")}
      data-greyed={greyed || undefined}
    >
      <span className="flex items-center gap-1.5">
        <HarnessLogo harnessId={harnessId} className="size-3" />
        {label}
        {missing.length > 0 && (
          <span className="text-[0.625rem] text-muted-foreground">· {missing.join(", ")}</span>
        )}
      </span>
    </SelectItem>
  );
}

function Cap({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
      {children}
    </span>
  );
}

function Meter({ fraction, color }: { fraction: number; color: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%`, background: color }}
      />
    </div>
  );
}

const STATUS_STYLE: Record<UsageLimitStatus, string> = {
  ok: "bg-success/15 text-foreground",
  warning: "bg-warning/15 text-warning",
  blocked: "bg-destructive text-destructive-foreground",
  unknown: "bg-muted text-muted-foreground",
};

function utilizationColor(utilization: number): string {
  if (utilization >= 0.9) return "hsl(var(--destructive))";
  if (utilization >= 0.7) return "var(--warning)";
  return "hsl(var(--foreground))";
}

function LimitsPanel({
  name,
  supported,
  row,
}: {
  name: string;
  supported: boolean;
  row: HarnessLimits | undefined;
}) {
  const { t } = useTranslation();
  // Reset countdowns tick by the minute while the section is open.
  const now = useClock(60_000);
  if (!supported) {
    return (
      <div className="space-y-1 opacity-60" data-testid="usage-limits">
        <div className="font-medium">{t("usageLimits")}</div>
        <div className="text-muted-foreground">{t("usageLimitsUnsupported", { name })}</div>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="space-y-1" data-testid="usage-limits">
        <div className="font-medium">{t("usageLimits")}</div>
        <div className="text-muted-foreground">{t("usageLimitsNone")}</div>
      </div>
    );
  }
  const { limits } = row;
  const overage =
    limits.usingOverage === null
      ? t("usageOverageUnknown")
      : limits.usingOverage
        ? t("usageOverageInUse")
        : t("usageOverageNotInUse");
  return (
    <div className="space-y-2" data-testid="usage-limits">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{t("usageLimits")}</div>
        <span className={cn("rounded px-1.5 py-0.5 text-[0.625rem]", STATUS_STYLE[limits.status])}>
          {t(`usageLimitStatus_${limits.status}`)}
        </span>
      </div>
      {limits.windows.length === 0 && (
        <div className="text-muted-foreground">{t("usageLimitsNoWindows")}</div>
      )}
      {limits.windows.map((window) => {
        const meta = [
          window.durationMs ? t("usageWindow", { duration: duration(window.durationMs) }) : null,
          window.resetsAt ? t("usageResetsIn", { time: until(window.resetsAt, now) }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={window.id} className="space-y-1">
            <div className="flex justify-between gap-2">
              <span className="font-mono text-[0.625rem]">{window.id}</span>
              <span className="font-medium tabular-nums">
                {Math.round(window.utilization * 100)}%
              </span>
            </div>
            <Meter fraction={window.utilization} color={utilizationColor(window.utilization)} />
            {meta && <div className="text-[0.625rem] text-muted-foreground">{meta}</div>}
          </div>
        );
      })}
      <div className="flex justify-between text-muted-foreground">
        <span>{t("usageOverage")}</span>
        <span className="text-foreground">{overage}</span>
      </div>
    </div>
  );
}
