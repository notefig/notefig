/**
 * A session's mark (MET-284): one of 24 shapes drawn in the session's color
 * on a tint of it. The shape and the color are picked apart (`shapeSlot`,
 * `colorSlot` on the task row), so the first 24 sessions of a workspace
 * never share a shape and the first 12 never share a color. Every shape is
 * one bold silhouette at about the same weight, so they stay apart at 14px
 * and in grayscale. A slot's meaning never changes: a shape may be redrawn,
 * but slot 7 is the arch for good, and new shapes go on the end.
 */
import { useId, type ReactElement } from "react";
import { sessionColor } from "./session-color";

type Draw = (ink: string, id: string) => ReactElement;

/** A wedge from the bottom-left corner, between two angles (degrees). */
function wedge(from: number, to: number): string {
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${(32 * Math.cos(rad)).toFixed(2)} ${(20 - 32 * Math.sin(rad)).toFixed(2)}`;
  };
  return `M0 20L${point(from)}L${point(to)}Z`;
}

/** Every shape on a 20×20 tile, in slot order: `SESSION_SHAPES` of them. */
const SHAPES: readonly Draw[] = [
  // 0 stripes
  (ink) => (
    <g stroke={ink} strokeWidth={3.4}>
      {[-6, 1, 8, 15, 22].map((x) => <path key={x} d={`M${x} 20L${x + 20} 0`} />)}
    </g>
  ),
  // 1 dots
  (ink) => (
    <g fill={ink}>
      {[[6, 6], [14, 6], [6, 14], [14, 14]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={2.9} />
      ))}
    </g>
  ),
  // 2 waves
  (ink) => (
    <g fill="none" stroke={ink} strokeWidth={2.8} strokeLinecap="round">
      {[7, 14].map((y) => <path key={y} d={`M-3 ${y}q2.5 -4 5 0t5 0t5 0t5 0t5 0`} />)}
    </g>
  ),
  // 3 quadrants
  (ink) => <path d="M0 0H10V10H0ZM10 10H20V20H10Z" fill={ink} />,
  // 4 half
  (ink) => <path d="M0 0H20L0 20Z" fill={ink} />,
  // 5 target
  (ink) => (
    <>
      <circle cx={10} cy={10} r={7} fill="none" stroke={ink} strokeWidth={2.6} />
      <circle cx={10} cy={10} r={2.8} fill={ink} />
    </>
  ),
  // 6 rays
  (ink) => (
    <g fill={ink}>
      {[0, 1, 2, 3].map((k) => <path key={k} d={wedge(k * 24, k * 24 + 12)} />)}
    </g>
  ),
  // 7 arch
  (ink) => <path d="M2 20V11.5a8 8 0 0 1 16 0V20Z" fill={ink} />,
  // 8 diamond
  (ink) => <path d="M10 2.5L17.5 10L10 17.5L2.5 10Z" fill={ink} />,
  // 9 triangle
  (ink) => (
    <path d="M10 2.8L18 16.8H2Z" fill={ink} stroke={ink} strokeWidth={1} strokeLinejoin="round" />
  ),
  // 10 leaf
  (ink) => <path d="M3 17V9.5A6.5 6.5 0 0 1 9.5 3H17V10.5A6.5 6.5 0 0 1 10.5 17Z" fill={ink} />,
  // 11 crescent
  (ink, id) => (
    <>
      <mask id={`${id}m`}>
        <rect width={20} height={20} fill="#fff" />
        <circle cx={13.6} cy={7.4} r={6.2} fill="#000" />
      </mask>
      <circle cx={10} cy={10} r={7.5} fill={ink} mask={`url(#${id}m)`} />
    </>
  ),
  // 12 hexagon
  (ink) => <path d="M6 3H14L18 10L14 17H6L2 10Z" fill={ink} />,
  // 13 pill
  (ink) => <rect x={2} y={6.5} width={16} height={7} rx={3.5} fill={ink} />,
  // 14 bowtie
  (ink) => (
    <path
      d="M2.5 4L10 10L2.5 16ZM17.5 4L10 10L17.5 16Z"
      fill={ink}
      stroke={ink}
      strokeWidth={0.8}
      strokeLinejoin="round"
    />
  ),
  // 15 ring
  (ink) => <circle cx={10} cy={10} r={5.6} fill="none" stroke={ink} strokeWidth={3.8} />,
  // 16 spark
  (ink) => <path d="M10 2Q11 9 18 10Q11 11 10 18Q9 11 2 10Q9 9 10 2Z" fill={ink} />,
  // 17 corner
  (ink) => <circle cx={20} cy={20} r={14} fill={ink} />,
  // 18 clover
  (ink) => (
    <g fill={ink}>
      {[[10, 6.2], [13.8, 10], [10, 13.8], [6.2, 10]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={3.7} />
      ))}
    </g>
  ),
  // 19 lens
  (ink) => <path d="M2 10Q10 1 18 10Q10 19 2 10Z" fill={ink} />,
  // 20 frame
  (ink) => (
    <rect x={4.2} y={4.2} width={11.6} height={11.6} rx={1.5} fill="none" stroke={ink} strokeWidth={3.2} />
  ),
  // 21 blocks
  (ink) => <path d="M3.5 3H9V11.5H16.5V17H3.5Z" fill={ink} />,
  // 22 bite
  (ink, id) => (
    <>
      <mask id={`${id}m`}>
        <rect width={20} height={20} fill="#fff" />
        <circle cx={17} cy={3} r={6.5} fill="#000" />
      </mask>
      <rect x={3} y={3} width={14} height={14} rx={2.5} fill={ink} mask={`url(#${id}m)`} />
    </>
  ),
  // 23 pie
  (ink) => <path d="M10 10V3A7 7 0 1 0 17 10Z" fill={ink} />,
];

/**
 * The mark itself, `size` pixels square. Without a color it is drawn in the
 * neutral muted color; without a shape it is a plain tile (a session from
 * before shapes, or one whose row hasn't loaded).
 */
export function SessionMarkIcon({
  colorSlot,
  shapeSlot,
  size = 14,
  className,
}: {
  colorSlot: number | undefined;
  shapeSlot: number | undefined;
  size?: number;
  className?: string;
}) {
  // SVG ids are document-wide: each mark clips and masks under its own.
  const id = `sm${useId().replace(/:/g, "")}`;
  const draw = shapeSlot === undefined ? undefined : SHAPES[shapeSlot];
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={className}
      data-session-mark={`${colorSlot ?? ""}:${shapeSlot ?? ""}`}
    >
      <clipPath id={`${id}c`}>
        <rect width={20} height={20} rx={5.5} />
      </clipPath>
      <g clipPath={`url(#${id}c)`}>
        <rect width={20} height={20} fill={sessionColor(colorSlot, 0.18)} />
        {draw?.(sessionColor(colorSlot), id)}
      </g>
    </svg>
  );
}
