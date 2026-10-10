/**
 * Settings → Usage: usage over time — every harness side by side, or one
 * harness by model, beside its breakdown and account limits — the share of
 * input read from cache by day of the week, and the average day hour by
 * hour. Everything reads the usage module's hourly
 * buckets for the chosen range; the grouping is `series.ts`'s, done once
 * per change.
 *
 * Charts show the three largest series and fold the rest into "Other", so
 * they stay readable however many harnesses or models there are. A harness
 * that never reports cost or limits (`core.harnessAdapters`, through the usage
 * module's `useHarnessReporting`) is greyed wherever those are asked for.
 * The metric and range controls sit in the section's header.
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
  cacheHitRate,
  costType,
  emptyTokens,
  addTokens,
  totalTokens,
  type Cost,
  type Usage,
} from "@notefig/shared/agent";
import { startOfHour } from "@/modules/usage";
import type {
  WeekdayTokens,
  HarnessLimits,
  UsageGrain,
  UsageSeries,
  UsageSlice,
} from "@/modules/usage";
import {
  useHarnessLimits,
  useHarnessReporting,
  useUsagePattern,
  useUsageSeries,
  useWeekdayTokens,
} from "@/modules/usage/react";
import type { UsageReporting } from "@/modules/harness-adapters";
import {
  useActiveHarnesses,
  useHarnessLabels,
} from "@/hooks/use-harness-selection";
import { SettingsSectionActions } from "@/components/editor/settings-section";
import { useClock } from "@/hooks/use-clock";
import { formatCost, formatTokens } from "@/utils/usage-format";
import {
  UsageBarChart,
  type ChartBar,
  type ChartSeries,
} from "./usage-bar-chart";
import { UsageAreaChart } from "./usage-area-chart";
import { UsageRadarChart, type RadarShape } from "./usage-radar-chart";

type Metric = "tokens" | "cost";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RANGES = [7, 30, 90] as const;
type RangeDays = (typeof RANGES)[number];

/** Each range's grain: days up to a month, weeks beyond. */
const GRAIN: Record<RangeDays, UsageGrain> = {
  7: "day",
  30: "day",
  90: "week",
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
/** The two rows of cards: a wide one beside a narrow one, then the other
 *  way round, the narrow ones a third of the width. */
const WIDE_NARROW = "grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]";
const NARROW_WIDE = "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]";
const OTHER_COLOR = "hsl(var(--muted-foreground) / 0.45)";
const OTHER_KEY = "\u0000other";
const NULL_KEY = "\u0000none";
/** The detail view's every-harness choice; no harness id starts with NUL. */
const ALL = "\u0000all";

function metricOf(usage: Usage, metric: Metric): number {
  return metric === "cost"
    ? (usage.cost?.amount ?? 0)
    : totalTokens(usage.tokens);
}

/** Whether a harness's series can show `metric`: cost only from one that
 *  reports it. */
function showsMetric(
  metric: Metric,
  reportingOf: (harnessId: string) => UsageReporting,
): (key: string | null) => boolean {
  return (key) => metric !== "cost" || (!!key && reportingOf(key).cost);
}

type ShownSeries = {
  series: ChartSeries[];
  /** Per slice, one value per series. */
  values: number[][];
  /** Per series, over every slice. */
  totals: number[];
};

/** A harness's own colour, when it has one. */
type ColorOf = (key: string | null) => string | undefined;

/** One colour per harness wherever harnesses sit side by side, by its
 *  tokens over the range — so switching to cost, or to the cache chart,
 *  doesn't repaint them. Past the palette, none. */
function harnessColors(byHarness: UsageSeries): ColorOf {
  const totals = new Map<string, number>();
  for (const point of byHarness.points) {
    for (const { key, usage } of point.groups) {
      if (key)
        totals.set(key, (totals.get(key) ?? 0) + totalTokens(usage.tokens));
    }
  }
  const ranked = [...totals.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
  );
  return (key) => (key === null ? undefined : PALETTE[ranked.indexOf(key)]);
}

/** Each key's colour: its own, else the next one no other key has. */
function paletteFor(
  keys: readonly (string | null)[],
  colorOf: ColorOf = () => undefined,
): string[] {
  const own = keys.map(colorOf);
  const spare = PALETTE.filter((color) => !own.includes(color));
  return own.map((color) => color ?? spare.shift() ?? OTHER_COLOR);
}

/** The largest groups as chart series, the rest summed into "Other". */
function topSeries(
  slices: readonly UsageSlice[],
  keys: readonly (string | null)[],
  metric: Metric,
  nameOf: (key: string | null) => string,
  otherName: string,
  include: (key: string | null) => boolean = () => true,
  colorOf?: ColorOf,
): ShownSeries {
  const totalOf = new Map<string | null, number>();
  for (const slice of slices) {
    for (const group of slice.groups) {
      if (!include(group.key)) continue;
      totalOf.set(
        group.key,
        (totalOf.get(group.key) ?? 0) + metricOf(group.usage, metric),
      );
    }
  }
  const ranked = keys
    .filter((key) => (totalOf.get(key) ?? 0) > 0)
    .sort((a, b) => (totalOf.get(b) ?? 0) - (totalOf.get(a) ?? 0));
  const shown =
    ranked.length <= TOP_SERIES + 1 ? ranked : ranked.slice(0, TOP_SERIES);
  const rest = new Set(ranked.slice(shown.length));

  const colors = paletteFor(shown, colorOf);
  const series: ChartSeries[] = shown.map((key, index) => ({
    key: key ?? NULL_KEY,
    name: nameOf(key),
    color: colors[index],
  }));
  if (rest.size > 0)
    series.push({ key: OTHER_KEY, name: otherName, color: OTHER_COLOR });

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

/** What a chart's costs are counted in: a currency, or a harness's credits. */
type CostUnit = Pick<Cost, "currency" | "type">;

const USD: CostUnit = { currency: "USD", type: "currency" };

function useFormatters({ currency, type }: CostUnit) {
  return useMemo(() => {
    const compactCost = (() => {
      try {
        return new Intl.NumberFormat(undefined, {
          notation: "compact",
          maximumFractionDigits: 1,
          ...(type === "currency" ? { style: "currency", currency } : {}),
        });
      } catch {
        return null;
      }
    })();
    return {
      value: (metric: Metric) => (value: number) =>
        metric === "cost"
          ? formatCost({ amount: value, currency, type })
          : formatTokens(value),
      axis: (metric: Metric) => (value: number) =>
        metric === "cost"
          ? (compactCost?.format(value) ?? `${value} ${currency}`)
          : formatTokens(value),
    };
  }, [currency, type]);
}

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
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
  if (ms >= DAY_MS)
    return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
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
  const dayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const hourEnd = startOfHour(now) + HOUR_MS;
  const range = useMemo(() => {
    const day = new Date(dayStart);
    return {
      from: new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate() - (rangeDays - 1),
      ).getTime(),
      to: new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate() + 1,
      ).getTime(),
    };
  }, [rangeDays, dayStart]);
  const patternRange = useMemo(
    () => ({ from: hourEnd - PATTERN_DAYS * DAY_MS, to: hourEnd }),
    [hourEnd],
  );
  return { range, patternRange };
}

/** The harnesses the detail view offers: the used ones first (a removed
 *  custom harness still has history), then every live one, then any that
 *  only reported limits. */
function useHarnessIds(
  byHarness: UsageSeries,
  limits: HarnessLimits[],
): string[] {
  const activeHarnesses = useActiveHarnesses();
  return useMemo(() => {
    const ids = new Set<string>();
    for (const key of byHarness.keys) if (key) ids.add(key);
    for (const harness of activeHarnesses) ids.add(harness.id);
    for (const row of limits) ids.add(row.harnessId);
    return [...ids];
  }, [byHarness.keys, activeHarnesses, limits]);
}

/** The unit some slices' costs are in: the first one seen that `accept`s,
 *  null when there is none. */
function costUnitOf(
  slices: readonly UsageSlice[],
  accept: (cost: Cost) => boolean = () => true,
): CostUnit | null {
  for (const slice of slices) {
    for (const { usage } of slice.groups) {
      if (usage.cost && accept(usage.cost)) {
        return { currency: usage.cost.currency, type: costType(usage.cost) };
      }
    }
  }
  return null;
}

/** What a view reads for the chosen harness: every harness side by side,
 *  or one harness's models. */
function scopeOf(harnessId: string) {
  return harnessId === ALL
    ? { groupBy: "harness" as const }
    : { harnessId, groupBy: "model" as const };
}

/** The harness the views show — `ALL` until one is picked, and
 *  again if the picked one leaves the list. */
function useChosenHarness(
  harnessIds: string[],
): [string, (harnessId: string) => void] {
  const [chosen, setChosen] = useState(ALL);
  return [harnessIds.includes(chosen) ? chosen : ALL, setChosen];
}

/** The money the views that stack harnesses chart cost in (a harness
 *  billing in credits charts them in its own card), and the daily
 *  pattern's formatters: one harness's in its own unit (credits, say). */
function useCostUnits(
  byHarness: UsageSeries,
  patternHours: readonly UsageSlice[],
  harnessId: string,
) {
  const money =
    costUnitOf(byHarness.points, (cost) => costType(cost) === "currency") ??
    USD;
  const own = harnessId === ALL ? null : costUnitOf(patternHours);
  return { money, patternFormatters: useFormatters(own ?? money) };
}

export function UsageSettings() {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<Metric>("tokens");
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const grain = GRAIN[rangeDays];
  const { range, patternRange } = useRanges(rangeDays);

  const byHarness = useUsageSeries({
    from: range.from,
    to: range.to,
    grain,
    groupBy: "harness",
  });
  const limits = useHarnessLimits();
  const labelOf = useHarnessLabels();
  const reportingOf = useHarnessReporting(byHarness, limits);
  const harnessIds = useHarnessIds(byHarness, limits);
  const [harnessId, setChosen] = useChosenHarness(harnessIds);
  const pattern = useUsagePattern({ ...patternRange, ...scopeOf(harnessId) });
  const { money, patternFormatters } = useCostUnits(
    byHarness,
    pattern.hours,
    harnessId,
  );
  const colorOf = useMemo(() => harnessColors(byHarness), [byHarness]);

  const metricName = metric === "cost" ? t("usageCost") : t("usageTokens");
  const rangeName = t("usageRangeDays", { count: rangeDays });
  const grainName = t(`usageGrain_${grain}`).toLowerCase();

  return (
    <div className="space-y-4 pt-2" data-testid="usage-settings">
      <UsageControls
        metric={metric}
        onMetric={setMetric}
        rangeDays={rangeDays}
        onRangeDays={setRangeDays}
      >
        <HarnessPicker
          value={harnessId}
          onChange={setChosen}
          harnessIds={harnessIds}
          labelOf={labelOf}
          reportingOf={reportingOf}
          metric={metric}
        />
      </UsageControls>
      <HarnessCard
        metric={metric}
        range={range}
        grain={grain}
        harnessId={harnessId}
        labelOf={labelOf}
        reportingOf={reportingOf}
        limits={limits}
        caption={{ grain: grainName, range: rangeName }}
        money={money}
        colorOf={colorOf}
      />
      <div className={NARROW_WIDE}>
        <CacheCard
          range={range}
          harnessId={harnessId}
          labelOf={labelOf}
          colorOf={colorOf}
        />
        <PatternCard
          harnessId={harnessId}
          metric={metric}
          labelOf={labelOf}
          reportingOf={reportingOf}
          colorOf={colorOf}
          format={patternFormatters.value(metric)}
          formatAxis={patternFormatters.axis(metric)}
          pattern={pattern}
          description={t("usagePatternDesc", {
            metric: metricName.toLowerCase(),
            count: PATTERN_DAYS,
          })}
        />
      </div>
    </div>
  );
}

function UsageControls({
  metric,
  onMetric,
  rangeDays,
  onRangeDays,
  children,
}: {
  metric: Metric;
  onMetric: (metric: Metric) => void;
  rangeDays: RangeDays;
  onRangeDays: (days: RangeDays) => void;
  /** The harness picker, last. */
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSectionActions>
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
      {children}
    </SettingsSectionActions>
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
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5"
    >
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
            className={cn(
              "gap-1.5 text-xs",
              option.greyed && "text-muted-foreground",
            )}
            data-greyed={option.greyed || undefined}
          >
            <span className="flex flex-1 items-center gap-1.5">
              {option.label}
            </span>
            {option.value === value && <Check className="size-3 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Card({
  children,
  testId,
  className,
}: {
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-4 rounded-lg border border-border p-4", className)}
      data-testid={testId}
    >
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

function periodLabels(
  grain: UsageGrain,
  start: number,
  weekOf: (date: string) => string,
) {
  const date = new Date(start);
  if (grain === "quarter") {
    const label = `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
    return { axis: label, title: label };
  }
  if (grain === "month") {
    return {
      axis: date.toLocaleDateString(undefined, { month: "short" }),
      title: date.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    };
  }
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return {
    axis: day,
    title:
      grain === "week"
        ? weekOf(day)
        : date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
  };
}

/** A series over periods as stacked areas, or a line saying the range is
 *  empty. A greyed placeholder (`overlay`) is bars. */
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
  /** Sizes the chart (see `UsageBarChart`). */
  className: string;
  overlay?: string;
  testId: string;
}) {
  const { t } = useTranslation();
  if (points.every((point) => point.turns === 0)) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("usageNoUsageInRange")}
      </p>
    );
  }
  const bars = seriesBars(points, shown.values, grain, (date) =>
    t("usageWeekOf", { date }),
  );
  return chart.overlay === undefined ? (
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

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Monday first, as the usage views start their weeks (2024-01-01 was a
 *  Monday). */
function weekdayName(index: number): string {
  return new Date(2024, 0, 1 + index).toLocaleDateString(undefined, {
    weekday: "short",
  });
}

/** How much of the input was read from cache, by day of the week, over
 *  the range: for the harness the views show, or with all of them, one
 *  shape per harness (the largest three in their colours, the rest as
 *  "Other") over each other. The header reads out the hovered day, else the range. */
function CacheCard({
  range,
  harnessId,
  labelOf,
  colorOf,
}: {
  range: { from: number; to: number };
  harnessId: string;
  labelOf: (harnessId: string) => string;
  colorOf: ColorOf;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const harnesses = useWeekdayTokens({
    ...range,
    harnessId: harnessId === ALL ? undefined : harnessId,
  });
  const days = WEEKDAYS.map((index) =>
    harnesses.reduce((sum, h) => addTokens(sum, h.days[index]), emptyTokens()),
  );
  const total = days.reduce(addTokens, emptyTokens());
  const whole = cacheHitRate(total);
  const tokens = hovered === null ? total : days[hovered];
  const rate = cacheHitRate(tokens);
  const counts = t("usageCacheDetail", {
    read: formatTokens(tokens.cacheRead),
    input: formatTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite),
  });
  const perHarness = harnessId === ALL && harnesses.length > 1;
  const entries = perHarness
    ? cacheEntries(harnesses, labelOf, colorOf, t("usageOther"))
    : [];
  const shapes: RadarShape[] = perHarness
    ? entries.map(({ key, color, days }) => ({
        key,
        color,
        values: days.map(cacheHitRate),
      }))
    : [{ key: ALL, color: PALETTE[0], values: days.map(cacheHitRate) }];

  return (
    <Card testId="usage-cache">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.8125rem] font-medium">
            {t("usageCacheTitle")}
          </div>
          {whole !== null && (
            <div
              className="truncate text-[0.625rem] text-muted-foreground"
              title={counts}
            >
              {counts}
            </div>
          )}
        </div>
        {whole !== null && (
          <div
            className="shrink-0 text-[0.625rem] text-muted-foreground"
            data-testid="usage-cache-readout"
          >
            {hovered === null ? t("usageCacheHitRate") : weekdayName(hovered)}{" "}
            <span className="font-medium tabular-nums text-foreground">
              {rate === null ? "—" : percent(rate)}
            </span>
          </div>
        )}
      </div>
      {whole === null ? (
        <p className="text-xs text-muted-foreground">
          {t("usageNoUsageInRange")}
        </p>
      ) : (
        <UsageRadarChart
          labels={WEEKDAYS.map(weekdayName)}
          shapes={shapes}
          hovered={hovered}
          onHover={setHovered}
          testId="usage-chart-cache"
        />
      )}
      {perHarness && whole !== null && (
        <CacheLegend entries={entries} hovered={hovered} />
      )}
    </Card>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

type CacheEntry = {
  key: string;
  name: string;
  color: string;
  days: WeekdayTokens["days"];
};

/** The harnesses the cache chart draws, as the other charts do: the
 *  largest three in their own colours, the rest added into "Other". */
function cacheEntries(
  harnesses: readonly WeekdayTokens[],
  labelOf: (harnessId: string) => string,
  colorOf: ColorOf,
  otherName: string,
): CacheEntry[] {
  const shown =
    harnesses.length <= TOP_SERIES + 1
      ? harnesses
      : harnesses.slice(0, TOP_SERIES);
  const colors = paletteFor(
    shown.map((h) => h.harnessId),
    colorOf,
  );
  const entries: CacheEntry[] = shown.map(({ harnessId, days }, index) => ({
    key: harnessId,
    name: labelOf(harnessId),
    color: colors[index],
    days,
  }));
  const rest = harnesses.slice(shown.length);
  if (rest.length > 0) {
    entries.push({
      key: OTHER_KEY,
      name: otherName,
      color: OTHER_COLOR,
      days: WEEKDAYS.map((index) =>
        rest.reduce((sum, h) => addTokens(sum, h.days[index]), emptyTokens()),
      ),
    });
  }
  return entries;
}

/** Which shape is which harness, with its rate for the hovered day, else
 *  the range. */
function CacheLegend({
  entries,
  hovered,
}: {
  entries: CacheEntry[];
  hovered: number | null;
}) {
  return (
    <div
      className="space-y-1 text-[0.625rem]"
      data-testid="usage-cache-harnesses"
    >
      {entries.map(({ key, name, color, days }) => {
        const rate = cacheHitRate(
          hovered === null
            ? days.reduce(addTokens, emptyTokens())
            : days[hovered],
        );
        return (
          <div key={key} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {name}
            </span>
            <span className="font-medium tabular-nums">
              {rate === null ? "—" : percent(rate)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PatternCard({
  harnessId,
  metric,
  pattern,
  description,
  labelOf,
  reportingOf,
  colorOf,
  format,
  formatAxis,
}: Shared & {
  /** The chosen harness, or `ALL`: split by harness, or by its models. */
  harnessId: string;
  colorOf: ColorOf;
  pattern: {
    hours: (UsageSlice & { hour: number })[];
    keys: (string | null)[];
  };
  description: string;
}) {
  const { t } = useTranslation();
  const shown =
    harnessId === ALL
      ? topSeries(
          pattern.hours,
          pattern.keys,
          metric,
          (key) => labelOf(key ?? ""),
          t("usageOther"),
          showsMetric(metric, reportingOf),
          colorOf,
        )
      : topSeries(
          pattern.hours,
          pattern.keys,
          metric,
          (key) => key ?? t("usageUnknownModel"),
          t("usageOther"),
        );
  const empty = shown.values.every((row) => row.every((value) => value === 0));

  return (
    // A column, so the chart takes the height its row gives it — the cache
    // card beside it grows with its legend.
    <Card testId="usage-pattern" className="flex flex-col">
      <div>
        <div className="text-[0.8125rem] font-medium">
          {t("usageDailyPattern")}
        </div>
        <div className="text-[0.625rem] text-muted-foreground">
          {description}
        </div>
      </div>
      {empty ? (
        <p className="text-xs text-muted-foreground">
          {t("usageNoUsageInRange")}
        </p>
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
          className="min-h-[180px] flex-1"
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
  harnessId,
  labelOf,
  reportingOf,
  limits,
  caption,
  money,
  colorOf,
}: {
  metric: Metric;
  range: { from: number; to: number };
  grain: UsageGrain;
  /** The chosen harness, or `ALL`. */
  harnessId: string;
  labelOf: (harnessId: string) => string;
  reportingOf: (harnessId: string) => UsageReporting;
  limits: HarnessLimits[];
  /** The range and grain, as the captions name them. */
  caption: { grain: string; range: string };
  /** The unit the stacked views chart cost in. */
  money: CostUnit;
  colorOf: ColorOf;
}) {
  const { t } = useTranslation();
  const all = harnessId === ALL;
  // Every harness side by side, or one harness's models.
  const series = useUsageSeries({
    from: range.from,
    to: range.to,
    grain,
    ...scopeOf(harnessId),
  });
  const reporting = all ? null : reportingOf(harnessId);
  const view = useDetailView(series, {
    all,
    harnessId,
    metric,
    money,
    labelOf,
    reportingOf,
    colorOf,
    caption,
  });
  const format = view.formatters.value(view.shownMetric);

  return (
    <div className={WIDE_NARROW} data-testid="usage-harness-detail">
      <Card>
        <div>
          <HarnessTitle
            name={view.name}
            reporting={reporting}
            unit={view.unit}
          />
          <div className="text-[0.625rem] text-muted-foreground">
            {view.description}
          </div>
        </div>
        {/* Greyed tokens under `overlay` when the view asks for a cost no
            harness in it reports, or it names no models. */}
        <PeriodChart
          points={series.points}
          shown={view.shown}
          grain={grain}
          format={format}
          formatAxis={view.formatters.axis(view.shownMetric)}
          className="h-[13.5rem]"
          overlay={view.disabled?.overlay}
          testId={all ? "usage-chart-harness" : "usage-chart-models"}
        />
      </Card>

      <Card>
        <div className="text-[0.8125rem] font-medium">
          {all ? t("usageByHarness") : t("usageByModel")}
        </div>
        <div className="space-y-4 text-[0.625rem]">
          <BreakdownPanel
            shown={view.shown}
            format={format}
            unnamed={view.unnamed}
            name={view.name}
            withoutCost={view.withoutCost.map(labelOf)}
          />
          {reporting ? (
            <LimitsPanel
              name={view.name}
              supported={reporting.limits}
              row={limits.find((row) => row.harnessId === harnessId)}
            />
          ) : (
            <AllLimitsPanel limits={limits} labelOf={labelOf} />
          )}
        </div>
      </Card>
    </div>
  );
}

type DetailScope = {
  all: boolean;
  harnessId: string;
  metric: Metric;
  money: CostUnit;
  labelOf: (harnessId: string) => string;
  reportingOf: (harnessId: string) => UsageReporting;
  colorOf: ColorOf;
  caption: { grain: string; range: string };
};

/** What the detail chart shows. For one harness: its models, its cost in
 *  its own unit (or the money the others chart in). For all: each harness
 *  that can show the metric, in money. Tokens, greyed, when the view asks
 *  for a cost none of them has, or one harness names no models. */
function useDetailView(series: UsageSeries, scope: DetailScope) {
  const { t } = useTranslation();
  const { all, metric, money, caption } = scope;
  const name = all ? t("usageAllHarnesses") : scope.labelOf(scope.harnessId);
  const unit = detailCostUnit(series, scope);
  const formatters = useFormatters(unit ?? money);
  const noCost = metric === "cost" && !unit;
  const unnamed = !all && namesNoModels(series.keys);
  const shownMetric: Metric = noCost ? "tokens" : metric;
  const disabled = detailChartDisabled({ noCost, unnamed, all, name }, t);
  const description =
    disabled?.note ??
    t(all ? "usageAllDesc" : "usageDetailDesc", {
      metric: shownMetric === "cost" ? t("usageCost") : t("usageTokens"),
      ...caption,
    });
  return {
    name,
    unit,
    formatters,
    shownMetric,
    unnamed,
    disabled,
    description,
    ...detailSeries(series, scope, shownMetric, t),
  };
}

/** All harnesses chart cost in money, when any of them reports it. */
function detailCostUnit(
  series: UsageSeries,
  { all, harnessId, money, reportingOf }: DetailScope,
): CostUnit | null {
  if (!all) return harnessCostUnit(series, reportingOf(harnessId), money);
  return series.keys.some(showsMetric("cost", reportingOf)) ? money : null;
}

/** The chart's series — harnesses or models — and, for a cost view of all
 *  harnesses, the ones left out for having none. */
function detailSeries(
  series: UsageSeries,
  { all, labelOf, reportingOf, colorOf }: DetailScope,
  metric: Metric,
  t: TFunction,
): { shown: ShownSeries; withoutCost: string[] } {
  if (!all) {
    return {
      shown: topSeries(
        series.points,
        series.keys,
        metric,
        (key) => key ?? t("usageUnknownModel"),
        t("usageOther"),
      ),
      withoutCost: [],
    };
  }
  const canShow = showsMetric(metric, reportingOf);
  return {
    shown: topSeries(
      series.points,
      series.keys,
      metric,
      (key) => labelOf(key ?? ""),
      t("usageOther"),
      canShow,
      colorOf,
    ),
    withoutCost: series.keys.filter(
      (key): key is string => !!key && !canShow(key),
    ),
  };
}

/** The unit one harness's cost charts in: its own when the range shows it
 *  billing in credits, the stacked views' money when it reports cost, null
 *  when it has no cost to chart. */
function harnessCostUnit(
  series: UsageSeries,
  reporting: UsageReporting,
  money: CostUnit,
): CostUnit | null {
  const credits = costUnitOf(
    series.points,
    (cost) => costType(cost) === "credits",
  );
  return credits ?? (reporting.cost ? money : null);
}

/** Usage that names no model has no breakdown to chart. */
function namesNoModels(keys: readonly (string | null)[]): boolean {
  return keys.length > 0 && keys.every((key) => key === null);
}

function detailChartDisabled(
  {
    noCost,
    unnamed,
    all,
    name,
  }: { noCost: boolean; unnamed: boolean; all: boolean; name: string },
  t: TFunction,
): { overlay: string; note: string } | undefined {
  if (noCost)
    return {
      overlay: t("usageNoCostData"),
      note: all ? t("usageAllNoCost") : t("usageDetailNoCost", { name }),
    };
  if (unnamed)
    return {
      overlay: t("usageNoModelData"),
      note: t("usageNoModelNames", { name }),
    };
  return undefined;
}

function HarnessTitle({
  name,
  reporting,
  unit,
}: {
  name: string;
  /** Null for all harnesses together, which have no one set of caps. */
  reporting: UsageReporting | null;
  /** What its cost charts in; null when it has none. */
  unit: CostUnit | null;
}) {
  const { t } = useTranslation();
  if (!reporting)
    return <div className="text-[0.8125rem] font-medium">{name}</div>;
  const costCap = !unit
    ? t("usageCapTokensOnly")
    : unit.type === "credits"
      ? t("usageCapCredits")
      : t("usageCapCost");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="text-[0.8125rem] font-medium">{name}</div>
      <Cap>{costCap}</Cap>
      <Cap>
        {reporting.limits ? t("usageCapLimits") : t("usageCapNoLimits")}
      </Cap>
    </div>
  );
}

/** All harnesses, then each, greyed when it lacks what the view is showing
 *  (cost), or reports neither cost nor limits. */
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
      options={[
        { value: ALL, label: t("usageAllHarnesses") },
        ...harnessIds.map((id) => {
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
        }),
      ]}
    />
  );
}

/** The chart's series over the range: one bar split by each one's share of
 *  the whole, then each with its total and share. */
function BreakdownPanel({
  shown,
  format,
  unnamed,
  name,
  withoutCost,
}: {
  shown: ShownSeries;
  format: (value: number) => string;
  /** The harness names no models at all. */
  unnamed: boolean;
  name: string;
  /** Harnesses left out of a cost view, by name. */
  withoutCost: string[];
}) {
  const { t } = useTranslation();
  const sum = shown.totals.reduce((a, b) => a + b, 0);
  if (unnamed) {
    return (
      <div className="text-muted-foreground opacity-60">
        {t("usageNoModelNames", { name })}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="usage-breakdown">
      {shown.series.length === 0 && (
        <div className="text-muted-foreground">{t("usageNoUsageInRange")}</div>
      )}
      {sum > 0 && (
        <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/10">
          {shown.series.map((s, index) => (
            <div
              key={s.key}
              className="h-full"
              style={{
                width: `${(shown.totals[index] / sum) * 100}%`,
                background: s.color,
              }}
            />
          ))}
        </div>
      )}
      {shown.series.map((s, index) => (
        <BreakdownRow
          key={s.key}
          name={s.name}
          color={s.color}
          value={format(shown.totals[index])}
          share={sum ? Math.round((shown.totals[index] / sum) * 100) : 0}
        />
      ))}
      {withoutCost.map((harness) => (
        <BreakdownRow
          key={harness}
          name={harness}
          color={OTHER_COLOR}
          value={t("usageNoCostData")}
          muted
        />
      ))}
    </div>
  );
}

function BreakdownRow({
  name,
  color,
  value,
  share,
  muted = false,
}: {
  name: string;
  color: string;
  value: string;
  share?: number;
  muted?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", muted && "opacity-60")}>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="font-medium tabular-nums">{value}</span>
      <span className="w-8 text-end tabular-nums text-muted-foreground">
        {share === undefined ? "" : `${share}%`}
      </span>
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
        style={{
          width: `${Math.min(1, Math.max(0, fraction)) * 100}%`,
          background: color,
        }}
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
  if (!supported) {
    return (
      <div
        className="text-muted-foreground opacity-60"
        data-testid="usage-limits"
      >
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
  return (
    <div data-testid="usage-limits">
      <LimitWindows limits={row.limits} />
    </div>
  );
}

/** Every harness's last reported limits, under its name. */
function AllLimitsPanel({
  limits,
  labelOf,
}: {
  limits: HarnessLimits[];
  labelOf: (harnessId: string) => string;
}) {
  if (limits.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="usage-limits">
      {limits.map((row) => (
        <div key={row.harnessId} className="space-y-1.5">
          <div className="flex items-center gap-1.5 font-medium">
            <HarnessLogo harnessId={row.harnessId} className="size-3" />
            {labelOf(row.harnessId)}
          </div>
          <LimitWindows limits={row.limits} />
        </div>
      ))}
    </div>
  );
}

function LimitWindows({ limits }: { limits: HarnessLimits["limits"] }) {
  const { t } = useTranslation();
  // Reset countdowns tick by the minute while the section is open.
  const now = useClock(MINUTE_MS);
  return (
    <div className="space-y-2">
      {limits.windows.length === 0 && (
        // With no windows to show, a reported warning or block is all there is.
        <div
          className={cn(
            limits.status === "warning" && "text-warning",
            limits.status === "blocked" && "text-destructive",
            (limits.status === "ok" || limits.status === "unknown") &&
              "text-muted-foreground",
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
          window.durationMs
            ? t("usageWindow", { duration: duration(window.durationMs) })
            : null,
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
            <Meter
              fraction={utilization}
              color={utilizationColor(utilization)}
            />
            {meta && (
              <div className="text-[0.625rem] text-muted-foreground">
                {meta}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
