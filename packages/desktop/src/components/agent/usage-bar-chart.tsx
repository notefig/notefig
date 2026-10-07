/**
 * A stacked bar chart for the usage views: one bar per period (or hour of
 * day), one segment per series, a hover tooltip with the breakdown. Plain
 * divs on theme tokens — no charting library.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";

export type ChartSeries = {
  key: string;
  name: string;
  /** Any CSS color; the views pass theme tokens (`hsl(var(--chart-1))`). */
  color: string;
};

export type ChartBar = {
  key: string | number;
  /** Under the bar; empty to leave a gap (labels thin out as bars multiply). */
  axisLabel: string;
  /** Heads the tooltip. */
  title: string;
  /** One per series, in the series' order. */
  values: number[];
};

const TICKS = 4;

/** 1, 2, 2.5 or 5 × a power of ten, at least `x`: steps an axis reads easily. */
function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(x));
  const fraction = x / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

export function UsageBarChart({
  series,
  bars,
  format,
  formatAxis = format,
  height,
  overlay,
  testId,
}: {
  series: ChartSeries[];
  bars: ChartBar[];
  /** A value as the tooltip shows it. */
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
  /** Plot height in px. */
  height: number;
  /** Shown over the plot, which is then greyed (e.g. "No cost data"). */
  overlay?: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const totals = bars.map((bar) => bar.values.reduce((sum, value) => sum + value, 0));
  const step = niceStep(Math.max(0, ...totals) / TICKS);
  const top = step * TICKS;
  const count = bars.length;
  const gap = count > 60 ? "2px" : count > 20 ? "3px" : "8px";
  const radius = count > 40 ? "2px" : "3px";
  const ghost = overlay !== undefined;
  const hover = !ghost && hovered !== null && hovered < count ? hovered : null;
  const ticks = Array.from({ length: TICKS + 1 }, (_, index) => index);

  return (
    <div className="flex gap-2 text-[0.6875rem]" data-testid={testId}>
      <div className="relative w-10 shrink-0" style={{ height }}>
        {!ghost &&
          ticks.map((index) => (
            <div
              key={index}
              className="absolute end-0 translate-y-1/2 tabular-nums text-muted-foreground"
              style={{ bottom: `${(index / TICKS) * 100}%` }}
            >
              {index === 0 ? "0" : formatAxis(step * index)}
            </div>
          ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          className="relative"
          style={{ height }}
          onMouseLeave={() => setHovered(null)}
        >
          {ticks.map((index) => (
            <div
              key={index}
              className={cn(
                "absolute inset-x-0 border-t border-border",
                index > 0 && "border-dashed",
              )}
              style={{ bottom: `${(index / TICKS) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex" style={{ gap }}>
            {bars.map((bar, index) => (
              <div
                key={bar.key}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-center justify-end",
                  index === hover && "bg-foreground/5",
                )}
                style={{ borderRadius: radius }}
                onMouseEnter={() => setHovered(index)}
                data-testid="usage-bar"
              >
                <div
                  className="flex w-[70%] max-w-14 flex-col-reverse overflow-hidden"
                  style={{
                    height: `${top ? (totals[index] / top) * 100 : 0}%`,
                    borderRadius: `${radius} ${radius} 0 0`,
                  }}
                >
                  {series.map((s, seriesIndex) => (
                    <div
                      key={s.key}
                      className="shrink-0"
                      style={{
                        height: totals[index]
                          ? `${(bar.values[seriesIndex] / totals[index]) * 100}%`
                          : 0,
                        background: ghost ? "hsl(var(--muted-foreground) / 0.25)" : s.color,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <Tooltip
              bar={bars[hover]}
              total={totals[hover]}
              series={series}
              format={format}
              totalLabel={t("usageTotal")}
              style={
                (hover + 0.5) / count < 0.6
                  ? { left: `${((hover + 1) / count) * 100}%`, transform: "translateX(8px)" }
                  : {
                      left: `${(hover / count) * 100}%`,
                      transform: "translateX(calc(-100% - 8px))",
                    }
              }
            />
          )}
          {ghost && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
                {overlay}
              </span>
            </div>
          )}
        </div>
        <div className="flex" style={{ gap }}>
          {bars.map((bar) => (
            <div
              key={bar.key}
              className="flex min-w-0 flex-1 justify-center whitespace-nowrap text-muted-foreground"
            >
              {bar.axisLabel}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tooltip({
  bar,
  total,
  series,
  format,
  totalLabel,
  style,
}: {
  bar: ChartBar;
  total: number;
  series: ChartSeries[];
  format: (value: number) => string;
  totalLabel: string;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 flex min-w-40 flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
      style={style}
      data-testid="usage-chart-tooltip"
    >
      <div className="font-medium">{bar.title}</div>
      {series
        .map((s, index) => ({ ...s, value: bar.values[index] }))
        .reverse()
        .map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ background: row.color }} />
            <span className="flex-1 whitespace-nowrap text-muted-foreground">{row.name}</span>
            <span className="font-medium tabular-nums">{format(row.value)}</span>
          </div>
        ))}
      {series.length > 1 && (
        <div className="mt-0.5 flex justify-between gap-2 border-t border-border pt-1">
          <span className="font-medium">{totalLabel}</span>
          <span className="font-medium tabular-nums">{format(total)}</span>
        </div>
      )}
    </div>
  );
}
