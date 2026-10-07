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

/** A boundary between bands, in values: its height at each point and, per
 *  segment, the cubic's two inner control heights. */
type Curve = { at: number[]; c1: number[]; c2: number[] };

/** Monotone tangents (Fritsch–Carlson) for evenly spaced values: the cubic
 *  through them never overshoots, so it never dips below zero between two
 *  non-negative values. */
function tangentsOf(values: readonly number[]): number[] {
  const n = values.length;
  const slopes = values.slice(1).map((value, i) => value - values[i]);
  return values.map((_, i) => {
    if (i === 0) return slopes[0] ?? 0;
    if (i === n - 1) return slopes[n - 2];
    const [a, b] = [slopes[i - 1], slopes[i]];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
}

/** The stack's boundaries, from zero up, one per series. Each series is
 *  smoothed on its own values and the curves are added — not the sums
 *  smoothed — so a band is never thinner than zero and can't cross the one
 *  beneath it. With the points evenly spaced, adding cubics is adding
 *  their control heights. */
export function stackedCurves(bars: readonly ChartBar[], seriesCount: number): Curve[] {
  const n = bars.length;
  const segments = Math.max(0, n - 1);
  let curve: Curve = {
    at: bars.map(() => 0),
    c1: Array(segments).fill(0),
    c2: Array(segments).fill(0),
  };
  const curves = [curve];
  for (let s = 0; s < seriesCount; s++) {
    const values = bars.map((bar) => bar.values[s]);
    const m = tangentsOf(values);
    curve = {
      at: curve.at.map((y, i) => y + values[i]),
      c1: curve.c1.map((y, i) => y + values[i] + m[i] / 3),
      c2: curve.c2.map((y, i) => y + values[i + 1] - m[i + 1] / 3),
    };
    curves.push(curve);
  }
  return curves;
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

  const curves = stackedCurves(bars, series.length);
  /** A boundary as SVG path commands, left to right or back. */
  const trace = ({ at, c1, c2 }: Curve, back = false): string => {
    if (count === 1) {
      const y = yOf(at[0]);
      return back ? `L${WIDTH},${y}L0,${y}` : `M0,${y}L${WIDTH},${y}`;
    }
    const dx = xOf(1) / 3;
    if (!back) {
      return at.slice(1).reduce(
        (path, y, i) =>
          `${path}C${xOf(i) + dx},${yOf(c1[i])},${xOf(i + 1) - dx},${yOf(c2[i])},${xOf(i + 1)},${yOf(y)}`,
        `M0,${yOf(at[0])}`,
      );
    }
    let path = `L${WIDTH},${yOf(at[count - 1])}`;
    for (let i = count - 2; i >= 0; i--) {
      path += `C${xOf(i + 1) - dx},${yOf(c2[i])},${xOf(i) + dx},${yOf(c1[i])},${xOf(i)},${yOf(at[i])}`;
    }
    return path;
  };
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
                <path
                  d={`${trace(curves[index + 1])}${trace(curves[index], true)}Z`}
                  fill={`url(#${gradientId}-${index})`}
                />
                <path
                  d={trace(curves[index + 1])}
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
                    top: yOf(curves[index + 1].at[hover]),
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
