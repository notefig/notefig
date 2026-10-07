/**
 * A line chart for the usage views: one point per step (an hour of the
 * day), one line per series, each drawn at its own values — not stacked, so
 * a small series sits low and a large one high, and lines may cross. Each
 * line has a faint fill fading down to zero; the series come largest first,
 * so the larger fills sit behind and every line is drawn over all of them.
 * Smoothed, with a hover guide and the step's breakdown. Plain SVG on theme
 * tokens — no charting library — sharing the bar chart's data shape, axis
 * and tooltip.
 */
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import {
  AxisLabels,
  axisOver,
  CHART_GRID,
  GridLines,
  Tooltip,
  type ChartBar,
  type ChartSeries,
} from "./usage-bar-chart";

/** The plot's drawing size; the SVG stretches it to the real box, so a
 *  height in it is a percentage of the plot. */
const WIDTH = 1000;
const HEIGHT = 100;

/** Monotone tangents (Fritsch–Carlson) for evenly spaced values: the cubic
 *  through them never overshoots, so a line stays between its two points —
 *  never below zero, never above the axis. */
export function tangentsOf(values: readonly number[]): number[] {
  const n = values.length;
  const slopes = values.slice(1).map((value, i) => value - values[i]);
  return values.map((_, i) => {
    if (i === 0) return slopes[0] ?? 0;
    if (i === n - 1) return slopes[n - 2];
    const [a, b] = [slopes[i - 1], slopes[i]];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
}

export function UsageLineChart({
  series,
  bars,
  format,
  formatAxis = format,
  className,
  testId,
}: {
  series: ChartSeries[];
  /** One per step; `values` per series, in the series' order. */
  bars: ChartBar[];
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
  /** Sizes the chart, as `UsageBarChart`'s does. */
  className: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const gradientId = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const count = bars.length;
  const { step, top } = axisOver(
    Math.max(0, ...bars.flatMap((bar) => bar.values)),
  );
  const xOf = (index: number) =>
    count > 1 ? (index / (count - 1)) * WIDTH : 0;
  const yOf = (value: number) => HEIGHT - (top ? (value / top) * HEIGHT : 0);
  const fraction = (index: number) => (count > 1 ? index / (count - 1) : 0);

  /** One series' line as SVG path commands. */
  const trace = (s: number): string => {
    const values = bars.map((bar) => bar.values[s]);
    if (count === 1) return `M0,${yOf(values[0])}L${WIDTH},${yOf(values[0])}`;
    const m = tangentsOf(values);
    const dx = xOf(1) / 3;
    return values
      .slice(1)
      .reduce(
        (path, value, i) =>
          `${path}C${xOf(i) + dx},${yOf(values[i] + m[i] / 3)},${xOf(i + 1) - dx},${yOf(value - m[i + 1] / 3)},${xOf(i + 1)},${yOf(value)}`,
        `M0,${yOf(values[0])}`,
      );
  };
  const hover = hovered !== null && hovered < count ? hovered : null;

  const onMove = (event: React.MouseEvent) => {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const at = (event.clientX - rect.left) / rect.width;
    setHovered(Math.min(count - 1, Math.max(0, Math.round(at * (count - 1)))));
  };

  return (
    <div className={cn(CHART_GRID, className)} data-testid={testId}>
      <AxisLabels step={step} format={formatAxis} />
      <div
        ref={plot}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHovered(null)}
      >
        <GridLines />
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            {series.map((s, index) => (
              <linearGradient
                key={s.key}
                id={`${gradientId}-${index}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor={s.color} stopOpacity={0.45} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {series.map((s, index) => (
            <path
              key={s.key}
              d={`${trace(index)}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`}
              fill={`url(#${gradientId}-${index})`}
            />
          ))}
          {series.map((s, index) => (
            <path
              key={s.key}
              d={trace(index)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {hover !== null && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 border-s border-foreground/30"
              style={{ left: `${fraction(hover) * 100}%` }}
            />
            {series.map((s, index) => (
              <span
                key={s.key}
                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                style={{
                  left: `${fraction(hover) * 100}%`,
                  top: `${yOf(bars[hover].values[index])}%`,
                  background: s.color,
                }}
              />
            ))}
            <Tooltip
              bar={bars[hover]}
              total={bars[hover].values.reduce((sum, value) => sum + value, 0)}
              series={series}
              format={format}
              totalLabel={t("usageTotal")}
              style={{
                left: `${fraction(hover) * 100}%`,
                transform:
                  fraction(hover) < 0.6
                    ? "translateX(12px)"
                    : "translateX(calc(-100% - 12px))",
              }}
            />
          </>
        )}
      </div>
      <div className="relative col-start-2">
        {bars.map((bar, index) =>
          bar.axisLabel ? (
            <div
              key={bar.key}
              className="absolute whitespace-nowrap text-muted-foreground"
              style={{
                left: `${fraction(index) * 100}%`,
                // Centred on its point; the first may run into the axis
                // gutter, the last is kept inside the plot.
                transform:
                  index === count - 1 && index > 0
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
              }}
            >
              {bar.axisLabel}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
