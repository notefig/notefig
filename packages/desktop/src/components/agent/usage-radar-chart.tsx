/**
 * A radar chart for a share that repeats with a cycle (the days of the
 * week): one spoke per step, clockwise from the top, the centre at 0% and
 * the rim at 100%, the points joined into a filled shape. A step with
 * nothing to measure has no point and pulls the shape in to the centre.
 * Hovering a spoke's wedge lights it and tells the caller, which reads it
 * out. Plain SVG on theme tokens — no charting library.
 */
import { cn } from "@notefig/ui/utils";

export type RadarSpoke = {
  key: string | number;
  label: string;
  /** 0–1, or null when there was nothing to measure. */
  value: number | null;
};

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 84;
const RINGS = [0.25, 0.5, 0.75, 1];

function pointAt(index: number, count: number, r: number): [number, number] {
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

const polygon = (points: [number, number][]) =>
  points.map(([x, y]) => `${x},${y}`).join(" ");

/** A spoke's hover target: the wedge halfway to each neighbour, out past
 *  its label. */
function wedge(index: number, count: number): string {
  const reach = RADIUS + 28;
  return polygon([
    [CENTER, CENTER],
    pointAt(index - 0.5, count, reach),
    pointAt(index, count, reach),
    pointAt(index + 0.5, count, reach),
  ]);
}

export function UsageRadarChart({
  spokes,
  color,
  hovered,
  onHover,
  className,
  testId,
}: {
  spokes: RadarSpoke[];
  color: string;
  /** The spoke under the pointer, or null. */
  hovered: number | null;
  onHover: (index: number | null) => void;
  className?: string;
  testId?: string;
}) {
  const count = spokes.length;
  const shape = spokes.map((spoke, index) =>
    pointAt(index, count, (spoke.value ?? 0) * RADIUS),
  );

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={cn("mx-auto block w-full max-w-[240px]", className)}
      data-testid={testId}
      onMouseLeave={() => onHover(null)}
    >
      {RINGS.map((ring) => (
        <polygon
          key={ring}
          points={polygon(
            spokes.map((_, index) => pointAt(index, count, ring * RADIUS)),
          )}
          fill="none"
          stroke="hsl(var(--foreground) / 0.1)"
        />
      ))}
      {spokes.map((spoke, index) => {
        const [x, y] = pointAt(index, count, RADIUS);
        const [lx, ly] = pointAt(index, count, RADIUS + 16);
        return (
          <g key={spoke.key}>
            <line
              x1={CENTER}
              y1={CENTER}
              x2={x}
              y2={y}
              stroke="hsl(var(--foreground) / 0.1)"
            />
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="middle"
              className={cn(
                "fill-muted-foreground text-[11px]",
                index === hovered && "fill-foreground",
                spoke.value === null && "opacity-50",
              )}
            >
              {spoke.label}
            </text>
          </g>
        );
      })}
      <polygon
        points={polygon(shape)}
        fill={color}
        fillOpacity={0.25}
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {spokes.map((spoke, index) =>
        spoke.value === null ? null : (
          <circle
            key={spoke.key}
            cx={shape[index][0]}
            cy={shape[index][1]}
            r={index === hovered ? 3.5 : 2}
            fill={color}
          />
        ),
      )}
      {spokes.map((spoke, index) => (
        <polygon
          key={spoke.key}
          points={wedge(index, count)}
          fill="transparent"
          onMouseEnter={() => onHover(index)}
          data-testid={testId && `${testId}-spoke`}
        />
      ))}
    </svg>
  );
}
