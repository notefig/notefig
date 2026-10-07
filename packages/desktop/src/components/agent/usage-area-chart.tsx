/**
 * A stacked area chart for the usage views: one point per period, one band
 * per series, smoothed, filled with a fading gradient, and a hover guide
 * with the period's breakdown. Plain SVG on theme tokens — no charting
 * library — sharing the bar chart's data shape, axis and tooltip.
 */
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AxisLabels,
  GridLines,
  scaleOf,
  Tooltip,
  type ChartBar,
  type ChartSeries,
} from "./usage-bar-chart";

/** The plot's drawing width; the SVG stretches it to the real width. */
const WIDTH = 1000;

type Point = [x: number, y: number];

/** A monotone cubic through `points` (Fritsch–Carlson): smooth, but never
 *  overshooting a value, so a band never dips below the one beneath it. */
function monotonePath(points: Point[]): string {
  if (points.length === 1) {
    const [, y] = points[0];
    return `M0,${y}L${WIDTH},${y}`;
  }
  const n = points.length;
  const slopes = points.slice(1).map(([x, y], i) => (y - points[i][1]) / (x - points[i][0]));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    const [a, b] = [slopes[i - 1], slopes[i]];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = (x1 - x0) / 3;
    path += `C${x0 + dx},${y0 + tangents[i] * dx},${x1 - dx},${y1 - tangents[i + 1] * dx},${x1},${y1}`;
  }
  return path;
}

/** `top` traced forward, then `base` back: the closed band between them. */
function band(top: Point[], base: Point[]): string {
  if (top.length === 1) {
    return `M0,${top[0][1]}L${WIDTH},${top[0][1]}L${WIDTH},${base[0][1]}L0,${base[0][1]}Z`;
  }
  const back = monotonePath([...base].reverse()).replace(/^M/, "L");
  return `${monotonePath(top)}${back}Z`;
}

export function UsageAreaChart({
  series,
  bars,
  format,
  formatAxis = format,
  height,
  testId,
}: {
  series: ChartSeries[];
  /** One per period; `values` per series, in the series' order. */
  bars: ChartBar[];
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
  /** Plot height in px. */
  height: number;
  testId?: string;
}) {
  const { t } = useTranslation();
  const gradientId = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const count = bars.length;
  const { totals, step, top } = scaleOf(bars);
  const xOf = (index: number) => (count > 1 ? (index / (count - 1)) * WIDTH : 0);
  const yOf = (value: number) => height - (top ? (value / top) * height : 0);
  const fraction = (index: number) => (count > 1 ? index / (count - 1) : 0);

  // Each series' band sits on the running sum of the ones before it.
  const layers: Point[][] = [bars.map((_, index) => [xOf(index), yOf(0)])];
  const running = bars.map(() => 0);
  for (let s = 0; s < series.length; s++) {
    layers.push(
      bars.map((bar, index) => {
        running[index] += bar.values[s];
        return [xOf(index), yOf(running[index])];
      }),
    );
  }
  const hover = hovered !== null && hovered < count ? hovered : null;

  const onMove = (event: React.MouseEvent) => {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const at = (event.clientX - rect.left) / rect.width;
    setHovered(Math.min(count - 1, Math.max(0, Math.round(at * (count - 1)))));
  };

  return (
    <div className="flex gap-2 text-[0.6875rem]" data-testid={testId}>
      <AxisLabels height={height} step={step} format={formatAxis} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          ref={plot}
          className="relative"
          style={{ height }}
          onMouseMove={onMove}
          onMouseLeave={() => setHovered(null)}
        >
          <GridLines />
          <svg
            className="absolute inset-0 size-full overflow-visible"
            viewBox={`0 0 ${WIDTH} ${height}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              {series.map((s, index) => (
                <linearGradient key={s.key} id={`${gradientId}-${index}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0.1} />
                </linearGradient>
              ))}
            </defs>
            {series.map((s, index) => (
              <g key={s.key}>
                <path d={band(layers[index + 1], layers[index])} fill={`url(#${gradientId}-${index})`} />
                <path
                  d={monotonePath(layers[index + 1])}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
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
                    top: layers[index + 1][hover][1],
                    background: s.color,
                  }}
                />
              ))}
              <Tooltip
                bar={bars[hover]}
                total={totals[hover]}
                series={series}
                format={format}
                totalLabel={t("usageTotal")}
                style={
                  fraction(hover) < 0.6
                    ? { left: `${fraction(hover) * 100}%`, transform: "translateX(12px)" }
                    : {
                        left: `${fraction(hover) * 100}%`,
                        transform: "translateX(calc(-100% - 12px))",
                      }
                }
              />
            </>
          )}
        </div>
        <div className="relative h-4">
          {bars.map((bar, index) =>
            bar.axisLabel ? (
              <div
                key={bar.key}
                className="absolute whitespace-nowrap text-muted-foreground"
                style={{
                  left: `${fraction(index) * 100}%`,
                  transform:
                    index === 0
                      ? undefined
                      : index === count - 1
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
    </div>
  );
}
