// Inline loading indicator: a dotted 3D "thinking orb" on a plain 2D
// canvas. Vendored and trimmed from Jakubantalik/thinking-orbs (only the
// states we render, only the 20px preset, CSS-scaled to the 14–16px icon
// slots the old Loader2 spinners occupied). Ink is the canvas's CSS
// `currentColor` at varying opacity (upstream painted fixed grayscale),
// so the orb takes text color classes and matches sibling lucide icons —
// theme handling falls out for free. The orb keeps its own elapsed-time
// clock, so any pause freezes it mid-pose and resuming picks up exactly
// there: by default it animates whenever visible (pausing offscreen and
// on hidden tabs); with `animateOnHover` it rests frozen and moves only
// while its parent element is hovered. Reduced-motion users always get a
// static frame.
//
// Upstream: https://github.com/Jakubantalik/thinking-orbs
//
// MIT License — Copyright (c) 2026 Jakub Antalik
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type OrbState = "working" | "searching" | "solving" | "connecting";

// The tuned canvas size every preset below is baked for; rendered output
// is CSS-scaled down to the `size` prop.
const CANVAS_PX = 20;

// ---------------------------------------------------------------------
// Geometry + paint primitives. Honestly 3D: rotated, depth-shaded,
// z-sorted; depth carried by dot size and ink weight alone. Everything
// fills in currentColor; the ink value becomes opacity (a `white` of 0 —
// upstream's darkest ink — paints fully opaque), which reproduces the
// original grayscale exactly when currentColor is near-black on light /
// near-white on dark, and tints gracefully for muted foregrounds.

interface Dot {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Ink value: 0 = full-strength currentColor, 1 = fully transparent. */
  white: number;
  a?: number;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  white: number;
  a?: number;
  w: number;
}

type Projector = (x: number, y: number, z: number) => [number, number, number];

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/** Deterministic hash in [0, 1). */
function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Value noise on a 2D lattice — smooth, deterministic, cheap. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let fx = x - xi;
  let fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hashD(xi, yi);
  const b = hashD(xi + 1, yi);
  const c = hashD(xi, yi + 1);
  const d = hashD(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Stable directions on a unit sphere (Fibonacci lattice). */
function fibDir(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const rad = Math.sqrt(1 - y * y);
  const a = i * golden;
  return [rad * Math.cos(a), y, rad * Math.sin(a)];
}

/** Shortest signed angular distance, wrapped to (-π, π]. */
function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Shared spin + tilt + orthographic projection. */
function makeProj(
  yaw: number,
  tilt: number,
  cx: number,
  cy: number,
  scale: number,
): Projector {
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  const sy = Math.sin(yaw);
  const cyw = Math.cos(yaw);
  return (x, y, z) => {
    const x1 = x * cyw + z * sy;
    const z1 = -x * sy + z * cyw;
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}

/**
 * Z-sort far→near and fill dots in `ink` (the resolved currentColor,
 * already set as fillStyle by the caller) via per-dot globalAlpha —
 * keeping the color an opaque CSS string sidesteps parsing oklch etc.
 */
function paint(ctx: CanvasRenderingContext2D, dots: Dot[], rMin = 0.3): void {
  dots.sort((a, b) => a.z - b.z);
  for (const d of dots) {
    const w = Math.min(1, Math.max(0, d.white));
    const alpha = (1 - w) * (d.a ?? 1);
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Stroke pass for edge-based modes. Runs before `paint` so nodes sit on top. */
function paintLines(ctx: CanvasRenderingContext2D, lines: Line[]): void {
  for (const l of lines) {
    const w = Math.min(1, Math.max(0, l.white));
    const alpha = (1 - w) * (l.a ?? 1);
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = l.w;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Dot radii were tuned for a 300pt frame; sub-linear scaling keeps small
 * spinners legible.
 */
function radiusScale(size: number, pow: number): number {
  return (size / 300) ** pow;
}

// ---------------------------------------------------------------------
// The frame painters, with the upstream 20px preset baked directly into
// their constants (base "fine" profile × the 20px count/size
// multipliers, pre-resolved). Callers set fillStyle/strokeStyle to the
// resolved currentColor before invoking.

type ModeDraw = (
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
) => void;

// working — particles on tilted orbits (orbits @20: count ×0.238, size ×2.4)
const drawOrbits: ModeDraw = (ctx, size, t) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
  const rs = radiusScale(size, 0.6);

  const orbitN = 3;
  const ghostN = 10;
  const particles = 3;
  const ghostR = 0.9 * 2.4;
  const partR = 1.2 * 2.4;
  const partRDepth = 1.6 * 2.4;

  const dots: Dot[] = [];
  // orbits: each a tilted circle — a ghost path + running particles
  for (let orb = 0; orb < orbitN; orb++) {
    const h1 = hashD(orb, 1.7);
    const h2 = hashD(orb, 5.2);
    const h3 = hashD(orb, 8.9);
    const ro = R * (0.45 + 0.52 * h1);
    const th = h1 * 2 * Math.PI;
    const phi = Math.acos(2 * h2 - 1);
    // orbit plane basis (u, v ⟂ normal n)
    const nx = Math.sin(phi) * Math.cos(th);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(th);
    let ux = -ny;
    let uy = nx;
    const uz = 0;
    const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
    ux /= ul;
    uy /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

    // ghost path
    for (let k = 0; k < ghostN; k++) {
      const a = (k / ghostN) * 2 * Math.PI;
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro,
      );
      const depth = (z / ro + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z,
        r: ghostR * rs,
        white: 0.72,
        a: 0.5 * (0.4 + 0.6 * depth),
      });
    }
    // the particles doing the work
    for (let m = 0; m < particles; m++) {
      const a = t * speed + (m / particles) * 2 * Math.PI + h2 * 6;
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro,
      );
      const depth = (z / ro + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z,
        r: (partR + partRDepth * depth) * rs,
        white: 0.3 - 0.22 * depth,
      });
    }
  }
  paint(ctx, dots);
};

// searching — a scan meridian sweeps a dotted globe
// (globe @20: count ×0.105, size ×1.75, scanMul 4.335, dimBase 0.45)
const drawGlobe: ModeDraw = (ctx, size, t) => {
  const spin = 0.5;
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size / 2) * 0.82;
  const tilt = 0.4 + 0.06 * Math.sin(t * 0.35);
  const pt = makeProj(t * spin, tilt, cx, cy, radius);
  // scan sweeps relative to the spin; scanMul scales that relative rate
  const scan = t * (spin + (1.7 - spin) * 4.335);
  const rs = radiusScale(size, 0.6);
  const dimBase = 0.45;

  const latRings = 6;
  const lonDensity = 14;
  const rBase = 0.6 * 1.75;
  const rDepth = 1.7 * 1.75;
  const rBoost = 1.0;

  const dots: Dot[] = [];
  for (let li = 0; li <= latRings; li++) {
    const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI;
      const [px, py, z] = pt(
        cosLat * Math.cos(lon),
        sinLat,
        cosLat * Math.sin(lon),
      );
      const depth = (z + 1) / 2;
      // the scan: a moving meridian read as a size ripple, not a shine
      const d = angleDelta(lon + t * spin, scan);
      const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, z);
      dots.push({
        x: px,
        y: py,
        z,
        r: (rBase + rDepth * depth + rBoost * boost) * rs,
        white: 0.62 - 0.54 * depth,
        // dimBase < 1 fades un-scanned dots so the meridian reads clearly
        a: dimBase + (1 - dimBase) * Math.min(1, boost),
      });
    }
  }
  paint(ctx, dots);
};

// solving — bands scramble in quarter turns, then click back
// (rubik @20: count ×0.088, size ×1.9). Rapid eased moves scramble, then
// replay in reverse (palindrome) so everything clicks back to solved,
// rests, repeats.

interface Move {
  axis: 0 | 1 | 2;
  lo: number;
  hi: number;
  ang: number;
}

function makeMoves(count: number): Move[] {
  const moves: Move[] = [];
  for (let i = 0; i < count; i++) {
    const axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3)) as 0 | 1 | 2;
    const lo = -1.0 + 0.5 * Math.min(3, Math.floor(hashD(i, 5.9) * 4));
    const dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
  }
  return moves;
}

function solveCycle(
  time: number,
  count: number,
  slotDur: number,
  rest: number,
) {
  const cyc = 2 * count * slotDur + rest;
  const tc = time % cyc;
  const amount = new Array<number>(count).fill(0);
  let active = -1;
  if (tc < 2 * count * slotDur) {
    const slot = Math.floor(tc / slotDur);
    const p = (tc - slot * slotDur) / slotDur;
    const cl = Math.min(1, p / 0.7);
    const ep = 1 - (1 - cl) ** 3; // machine ease-out
    if (slot < count) {
      for (let i = 0; i < slot; i++) amount[i] = 1;
      amount[slot] = ep;
      active = slot;
    } else {
      const u = 2 * count - 1 - slot;
      for (let i = 0; i < u; i++) amount[i] = 1;
      amount[u] = 1 - ep;
      active = u;
    }
  }
  return { amount, active };
}

function applyMoves(
  pt3: [number, number, number],
  moves: Move[],
  sc: { amount: number[]; active: number },
): [number, number, number, boolean] {
  let [x, y, z] = pt3;
  let inActive = false;
  for (let i = 0; i < moves.length; i++) {
    if (sc.amount[i] <= 0) continue;
    const mv = moves[i];
    const coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
    if (coord < mv.lo || coord >= mv.hi) continue;
    if (i === sc.active) inActive = true;
    const a = mv.ang * sc.amount[i];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    if (mv.axis === 0) {
      const y2 = y * ca - z * sa;
      z = y * sa + z * ca;
      y = y2;
    } else if (mv.axis === 1) {
      const x2 = x * ca + z * sa;
      z = -x * sa + z * ca;
      x = x2;
    } else {
      const x2 = x * ca - y * sa;
      y = x * sa + y * ca;
      x = x2;
    }
  }
  return [x, y, z, inActive];
}

const drawRubik: ModeDraw = (ctx, size, t) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
  const rs = radiusScale(size, 0.6);
  const moveCount = 14;
  const moves = makeMoves(moveCount);
  const sc = solveCycle(t, moveCount, 0.42, 1.2);

  const latRings = 4;
  const lonDensity = 12;
  const rBase = 0.6 * 1.9;
  const rDepth = 1.7 * 1.9;
  const rActive = 0.3 * 1.9;

  const dots: Dot[] = [];
  for (let li = 0; li <= latRings; li++) {
    const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI;
      const [x, y, z, inActive] = applyMoves(
        [cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)],
        moves,
        sc,
      );
      const [px, py, zr] = pt(x, y, z);
      const depth = (zr + 1) / 2;
      // the band being turned inks a touch darker — the "hand"
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: (rBase + rDepth * depth + (inActive ? rActive : 0)) * rs,
        white: 0.62 - 0.54 * depth - (inActive ? 0.14 : 0),
      });
    }
  }
  paint(ctx, dots);
};

// connecting — a constellation wires itself, packets running the edges
// (web @20: count ×0.25, size ×1.52)
const drawWeb: ModeDraw = (ctx, size, t) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.8;
  // the projector carries the radius as its scale, so node vectors stay
  // unit-length and distances below are in unit-sphere space
  const pt = makeProj(t * 0.12, 0.32, cx, cy, R);
  const rs = radiusScale(size, 0.6);

  const nodeN = 8;
  const thr = 0.72;
  const nodeR = 1.4 * 1.52;
  const nodeRDepth = 1.8 * 1.52;
  const lineW = 0.8;
  const signals = 1;

  // nodes: fib lattice + slow noise wander, renormalised to the surface
  const nodes: Array<[number, number, number]> = [];
  for (let i = 0; i < nodeN; i++) {
    const d = fibDir(i, nodeN);
    const x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
    const y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
    const z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
    const l = Math.sqrt(x * x + y * y + z * z);
    nodes.push([x / l, y / l, z / l]);
  }

  const lines: Line[] = [];
  const dots: Dot[] = [];

  // edges between close neighbours, alpha by proximity + depth
  for (let i = 0; i < nodeN; i++) {
    for (let j = i + 1; j < nodeN; j++) {
      const dx = nodes[i][0] - nodes[j][0];
      const dy = nodes[i][1] - nodes[j][1];
      const dz = nodes[i][2] - nodes[j][2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= thr) continue;
      const [x1, y1, z1] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
      const [x2, y2, z2] = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
      const depth = ((z1 + z2) / 2 + 1) / 2;
      lines.push({
        x1,
        y1,
        x2,
        y2,
        white: 0.42,
        a: (1 - dist / thr) * (0.3 + 0.55 * depth),
        w: Math.max(0.6, lineW * rs),
      });
    }
  }

  for (let i = 0; i < nodeN; i++) {
    const [px, py, z] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
    const depth = (z + 1) / 2;
    const pulse = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
    dots.push({
      x: px,
      y: py,
      z,
      r: (nodeR + nodeRDepth * depth) * pulse * rs,
      white: 0.55 - 0.45 * depth,
    });
  }

  // signals: bright packets running between paired nodes
  for (let s = 0; s < signals; s++) {
    const seg = Math.floor(t * 0.55 + s * 7.31);
    const a = Math.floor(hashD(seg, s * 3.1 + 1.7) * nodeN);
    const b = Math.floor(hashD(seg, s * 5.7 + 4.2) * nodeN);
    if (a === b) continue;
    const f = frac(t * 0.55 + s * 7.31);
    const x = lerp(nodes[a][0], nodes[b][0], f);
    const y = lerp(nodes[a][1], nodes[b][1], f);
    const z = lerp(nodes[a][2], nodes[b][2], f);
    const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
    const [px, py, zr] = pt(x / l, y / l, z / l);
    const depth = (zr + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z: zr,
      r: (nodeR * 1.5 + nodeRDepth * depth) * rs,
      white: 0.05,
      a: 0.5 + 0.5 * depth,
    });
  }

  paintLines(ctx, lines);
  paint(ctx, dots);
};

// state → { painter, speed multiplier on the shared clock, aria label }
const STATES: Record<
  OrbState,
  { draw: ModeDraw; speed: number; label: string }
> = {
  working: { draw: drawOrbits, speed: 3.9, label: "Working…" },
  searching: { draw: drawGlobe, speed: 2.665, label: "Searching…" },
  solving: { draw: drawRubik, speed: 1.95, label: "Solving…" },
  connecting: { draw: drawWeb, speed: 6.63, label: "Connecting…" },
};

// ---------------------------------------------------------------------

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------

export function OrbLoader({
  state = "working",
  size = "0.875rem",
  animateOnHover = false,
  className,
}: {
  state?: OrbState;
  size?: number | string;
  /** Rest on a frozen frame and animate only while the parent element is
   *  hovered, resuming from the frozen pose. Default: animate always. */
  animateOnHover?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();
  // Animation time already played, in ms — the orb's own clock, advanced
  // only while the loop runs, so any pause (unhover, offscreen, hidden
  // tab) freezes it mid-pose and resuming picks up exactly there. Seeded
  // at 600ms — the same representative rest frame reduced-motion users
  // get.
  const elapsedRef = useRef(600);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(
      2,
      (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1,
    );
    canvas.width = Math.round(CANVAS_PX * dpr);
    canvas.height = Math.round(CANVAS_PX * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { draw, speed } = STATES[state];
    const frame = () => {
      // re-resolved every frame so class/theme-driven color changes are
      // picked up on the next repaint with no observers needed
      const ink = getComputedStyle(canvas).color;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
      ctx.fillStyle = ink;
      ctx.strokeStyle = ink;
      draw(ctx, CANVAS_PX, (elapsedRef.current / 1000) * speed);
    };

    // the resting frame: wherever the animation was left off
    frame();

    // reduced motion → stay on the static frame
    if (reduced) return;

    let raf = 0;
    let running = false;
    let last = 0;
    const loop = () => {
      const now = performance.now();
      elapsedRef.current += now - last;
      last = now;
      frame();
      if (running) raf = requestAnimationFrame(loop);
    };

    // run only while visible — and, in animateOnHover mode, hovered; the
    // hover target is the parent (the host button/row), since the canvas
    // itself is a ~14px sliver
    let hovered = !animateOnHover;
    let visible = true;
    const sync = () => {
      const should =
        hovered && visible && document.visibilityState !== "hidden";
      if (should && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const host = canvas.parentElement ?? canvas;
    const onEnter = () => {
      hovered = true;
      sync();
    };
    const onLeave = () => {
      hovered = false;
      sync();
    };
    if (animateOnHover) {
      host.addEventListener("pointerenter", onEnter);
      host.addEventListener("pointerleave", onLeave);
    }

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            sync();
          })
        : null;
    io?.observe(canvas);
    const onVis = () => sync();
    document.addEventListener("visibilitychange", onVis);
    if (!io) sync();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      if (animateOnHover) {
        host.removeEventListener("pointerenter", onEnter);
        host.removeEventListener("pointerleave", onLeave);
      }
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [state, reduced, animateOnHover]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={STATES[state].label}
      className={cn("shrink-0", className)}
      style={{ width: size, height: size, display: "block" }}
    />
  );
}
