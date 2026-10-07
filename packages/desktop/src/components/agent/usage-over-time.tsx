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
import type { TFunction } from "i18next";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { cn } from "@notefig/ui/utils";
import {
  totalTokens,
  type Usage,
} from "@notefig/shared/agent";
import { startOfHour } from "@/modules/usage";
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
import { useElementHeight } from "@/hooks/use-element-height";
import { formatCost, formatTokens } from "@/utils/usage-format";
import { UsageAreaChart } from "./usage-area-chart";
import { UsageBarChart, type ChartBar, type ChartSeries } from "./usage-bar-chart";

type Metric = "tokens" | "cost";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RANGES = [7, 30, 90] as const;
type RangeDays = (typeof RANGES)[number];

/** Each range's grain: days up to a month, weeks beyond. */
const GRAIN: Record<RangeDays, UsageGrain> = { 7: "day", 30: "day", 90: "week" };

const PATTERN_DAYS = 7;

/** The x-axis labels' row under a plot, with the gap above it. */
const AXIS_LABELS_PX = 22;

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

/** Thin out axis labels to about six (they fit a half-width card),
 *  counted back from the newest bar. */
function everyNth(count: number): (index: number) => boolean {
  const every = Math.max(1, Math.ceil(count / 6));
  return (index) => (count - 1 - index) % every === 0;
}

/** The over-time ranges, moving on with the clock so a section left open
 *  keeps taking in new hours, and the next day at midnight. The clock is
 *  by the minute — exact local time in every zone, where a UTC-hour floor
 *  lands half an hour early in a half-hour one — but the ranges only change
 *  at an hour or a day, so the queries over them rerun no more often. */
function useRanges(rangeDays: RangeDays) {
  const now = useClock(MINUTE_MS);
  const today = new Date(now);
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const hourEnd = startOfHour(now) + HOUR_MS;
  const range = useMemo(() => {
    const day = new Date(dayStart);
    return {
      from: new Date(day.getFullYear(), day.getMonth(), day.getDate() - (rangeDays - 1)).getTime(),
      to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
    };
  }, [rangeDays, dayStart]);
  const patternRange = useMemo(
    () => ({ from: hourEnd - PATTERN_DAYS * DAY_MS, to: hourEnd }),
    [hourEnd],
  );
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
  const grain = GRAIN[rangeDays];
  const { range, patternRange } = useRanges(rangeDays);

  const byHarness = useUsageSeries({ from: range.from, to: range.to, grain, groupBy: "harness" });
  const pattern = useUsagePattern({ ...patternRange, groupBy: "harness" });
  const limits = useHarnessLimits();
  const labelOf = useHarnessLabels();
  const { harnessIds, reportingOf, currency } = useHarnessFacts(byHarness, limits);
  const formatters = useFormatters(currency);

  const metricName = metric === "cost" ? t("usageCost") : t("usageTokens");
  const rangeName = t("usageRangeDays", { count: rangeDays });
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
        rangeDays={rangeDays}
        onRangeDays={setRangeDays}
      />
      <div className="grid gap-4 xl:grid-cols-2">
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
      </div>
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
  rangeDays,
  onRangeDays,
}: {
  metric: Metric;
  onMetric: (metric: Metric) => void;
  rangeDays: RangeDays;
  onRangeDays: (days: RangeDays) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium">{t("usageOverTime")}</h3>
        <p className="text-sm text-muted-foreground">{t("usageOverTimeHint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t("usageMetric")}
          value={metric}
          onChange={onMetric}
          options={[
            { value: "tokens", label: t("usageTokens") },
            { value: "cost", label: t("usageCost") },
          ]}
        />
        <Picker
          label={t("usageRange")}
          value={String(rangeDays)}
          onChange={(value) => onRangeDays(Number(value) as RangeDays)}
          options={RANGES.map((days) => ({
            value: String(days),
            label: t("usageRangeDays", { count: days }),
          }))}
        />
      </div>
    </div>
  );
}

/** Options side by side, the chosen one lit — the sidebar's tool toggles. */
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
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-6 rounded-md px-2 text-xs transition-colors",
            option.value === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type PickerOption = { value: string; label: React.ReactNode; greyed?: boolean };

/** A compact menu of choices on a ghost trigger, as the app's panels pick
 *  things (the composer's session options, the sidebar's menus). */
function Picker({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  testId?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className="flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {current?.label}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className={cn("gap-1.5 text-xs", option.greyed && "text-muted-foreground")}
            data-greyed={option.greyed || undefined}
          >
            <span className="flex flex-1 items-center gap-1.5">{option.label}</span>
            {option.value === value && <Check className="size-3 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Card({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="space-y-4 rounded-lg border border-border p-4" data-testid={testId}>
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

/** A series over periods — stacked areas, or bars — or a line saying the
 *  range is empty. */
function PeriodChart({
  points,
  shown,
  grain,
  area = false,
  ...chart
}: {
  points: (UsageSlice & { start: number })[];
  shown: ShownSeries;
  grain: UsageGrain;
  area?: boolean;
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
  const bars = seriesBars(points, shown.values, grain, (date) => t("usageWeekOf", { date }));
  return area ? (
    <UsageAreaChart {...chart} series={shown.series} bars={bars} />
  ) : (
    <UsageBarChart {...chart} series={shown.series} bars={bars} />
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
          <div className="text-[0.8125rem] font-medium">{t("usageByHarness")}</div>
          <div className="text-[0.625rem] text-muted-foreground">{description}</div>
        </div>
        <div className="flex flex-col gap-0.5">
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
        area
        testId="usage-chart-harness"
      />
    </Card>
  );
}

/** One line of a chart's legend: its color, name and total. */
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
    <div className={cn("flex items-center gap-1.5 text-[0.625rem]", muted && "opacity-60")}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-muted-foreground">{name}</span>
      <span className="ms-auto ps-3 font-medium tabular-nums">{value}</span>
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
  const empty = shown.values.every((row) => row.every((value) => value === 0));

  return (
    <Card testId="usage-pattern">
      <div>
        <div className="text-[0.8125rem] font-medium">{t("usageDailyPattern")}</div>
        <div className="text-[0.625rem] text-muted-foreground">{description}</div>
      </div>
      {empty ? (
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
          height={180}
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
  const noCost = metric === "cost" && !reporting.cost;
  const noModels = namesNoModels(byModel.keys);
  const shownMetric: Metric = noCost ? "tokens" : metric;
  const disabled = modelChartDisabled(noCost, noModels, name, t);
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
        <div>
          <HarnessTitle name={name} reporting={reporting} />
          <div className="text-[0.625rem] text-muted-foreground">
            {disabled?.note ??
              t("usageDetailDesc", {
                metric: shownMetric === "cost" ? t("usageCost") : t("usageTokens"),
                ...caption,
              })}
          </div>
        </div>
        <HarnessPicker
          value={harnessId}
          onChange={setChosen}
          harnessIds={harnessIds}
          labelOf={labelOf}
          reportingOf={reportingOf}
          metric={metric}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <ModelChart
          overlay={disabled?.overlay}
          points={byModel.points}
          shown={shown}
          grain={grain}
          format={format}
          formatAxis={formatters.axis(shownMetric)}
        />

        <div className="space-y-4 self-start rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <LimitsPanel
            name={name}
            supported={reporting.limits}
            row={limits.find((row) => row.harnessId === harnessId)}
          />
          <ModelsPanel shown={shown} format={format} unnamed={noModels} name={name} />
        </div>
      </div>
    </Card>
  );
}

/** Usage that names no model has no breakdown to chart. */
function namesNoModels(keys: readonly (string | null)[]): boolean {
  return keys.length > 0 && keys.every((key) => key === null);
}

function modelChartDisabled(
  noCost: boolean,
  noModels: boolean,
  name: string,
  t: TFunction,
): { overlay: string; note: string } | undefined {
  if (noCost) return { overlay: t("usageNoCostData"), note: t("usageDetailNoCost", { name }) };
  if (noModels) return { overlay: t("usageNoModelData"), note: t("usageNoModelNames", { name }) };
  return undefined;
}

function HarnessTitle({ name, reporting }: { name: string; reporting: UsageReporting }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="text-[0.8125rem] font-medium">{name}</div>
      <Cap>{reporting.cost ? t("usageCapCost") : t("usageCapTokensOnly")}</Cap>
      <Cap>{reporting.limits ? t("usageCapLimits") : t("usageCapNoLimits")}</Cap>
    </div>
  );
}

/** One harness's usage by model; greyed tokens under `overlay` when the
 *  view asks for a cost it doesn't report, or it names no models. */
function ModelChart({
  overlay,
  points,
  shown,
  grain,
  format,
  formatAxis,
}: {
  overlay: string | undefined;
  points: (UsageSlice & { start: number })[];
  shown: ShownSeries;
  grain: UsageGrain;
  format: (value: number) => string;
  formatAxis: (value: number) => string;
}) {
  // The plot fills the row, which the panel beside it may make taller than
  // the chart's own minimum; the axis labels under it take the rest.
  const [box, boxHeight] = useElementHeight<HTMLDivElement>();
  return (
    <div ref={box} className="relative min-h-[13.5rem] min-w-0">
      <div className="absolute inset-0">
        <PeriodChart
          points={points}
          shown={shown}
          grain={grain}
          format={format}
          formatAxis={formatAxis}
          height={Math.max(160, boxHeight - AXIS_LABELS_PX)}
          overlay={overlay}
          testId="usage-chart-models"
        />
      </div>
    </div>
  );
}

/** Every harness, greyed when it lacks what the view is showing (cost), or
 *  reports neither cost nor limits. */
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
    <Picker
      label={t("usageHarness")}
      value={value}
      onChange={onChange}
      testId="usage-harness-select"
      options={harnessIds.map((id) => {
        const reporting = reportingOf(id);
        return {
          value: id,
          label: (
            <>
              <HarnessLogo harnessId={id} className="size-3" />
              {labelOf(id)}
            </>
          ),
          greyed: (metric === "cost" || !reporting.limits) && !reporting.cost,
        };
      })}
    />
  );
}

/** A harness's models over the range, with each one's share. */
function ModelsPanel({
  shown,
  format,
  unnamed,
  name,
}: {
  shown: ShownSeries;
  format: (value: number) => string;
  /** The harness names no models at all. */
  unnamed: boolean;
  name: string;
}) {
  const { t } = useTranslation();
  const sum = shown.totals.reduce((a, b) => a + b, 0);
  if (unnamed) {
    return (
      <div className="text-muted-foreground opacity-60">{t("usageNoModelNames", { name })}</div>
    );
  }
  return (
    <div className="space-y-2">
      {shown.series.length === 0 && (
        <div className="text-muted-foreground">{t("usageNoUsageInRange")}</div>
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
  const now = useClock(MINUTE_MS);
  if (!supported) {
    return (
      <div className="text-muted-foreground opacity-60" data-testid="usage-limits">
        {t("usageLimitsUnsupported", { name })}
      </div>
    );
  }
  if (!row) {
    return (
      <div className="text-muted-foreground" data-testid="usage-limits">
        {t("usageLimitsNone")}
      </div>
    );
  }
  const { limits } = row;
  return (
    <div className="space-y-2" data-testid="usage-limits">
      {limits.windows.length === 0 && (
        // With no windows to show, a reported warning or block is all there is.
        <div
          className={cn(
            limits.status === "warning" && "text-warning",
            limits.status === "blocked" && "text-destructive",
            (limits.status === "ok" || limits.status === "unknown") && "text-muted-foreground",
          )}
        >
          {limits.status === "warning"
            ? t("usageLimitWarning")
            : limits.status === "blocked"
              ? t("usageLimitBlocked")
              : t("usageLimitsNoWindows")}
        </div>
      )}
      {limits.windows.map((window) => {
        // A stored report outlives its windows: one past its reset has
        // started over, whatever it last read.
        const reset = window.resetsAt !== null && window.resetsAt <= now;
        const utilization = reset ? 0 : window.utilization;
        const meta = [
          window.durationMs ? t("usageWindow", { duration: duration(window.durationMs) }) : null,
          reset
            ? t("usageWindowReset")
            : window.resetsAt
              ? t("usageResetsIn", { time: until(window.resetsAt, now) })
              : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={window.id} className="space-y-1">
            <div className="flex justify-between gap-2">
              <span className="font-mono text-[0.625rem]">{window.id}</span>
              <span className="font-medium tabular-nums">
                {reset ? "—" : `${Math.round(utilization * 100)}%`}
              </span>
            </div>
            <Meter fraction={utilization} color={utilizationColor(utilization)} />
            {meta && <div className="text-[0.625rem] text-muted-foreground">{meta}</div>}
          </div>
        );
      })}
    </div>
  );
}
