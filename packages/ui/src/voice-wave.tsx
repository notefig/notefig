// Voice wave: the "listening" counterpart of the thinking orb
// (orb-loader.tsx), drawn in the same language — dots on a small canvas,
// inked in the canvas's CSS `currentColor` at varying opacity, so it takes
// text color classes and themes for free. Five dotted columns rise and fall
// with the microphone's level; a slow sweep shades them like the orb's
// depth, and with no input they keep breathing low so an open mic never
// looks dead. Few, large dots: it has to read at 14–24px. Animates only while visible; reduced-motion users get a
// static frame.
//
// Framework-free at its core (`mountVoiceWave`), because the editor draws it
// inside a ProseMirror decoration; `VoiceWave` wraps it for React.

import { useEffect, useRef } from "react";
import { cn } from "./utils";

/** The tuned canvas size the constants below are baked for (CSS-scaled). */
const CANVAS_PX = 20;
const COLUMNS = 5;
const COLUMN_GAP = 3.5;
const DOT_GAP = 2.25;
/** ~30 fps: plenty for a wave this size. */
const FRAME_MS = 32;

export interface VoiceWaveOptions {
  /** The input level now, 0–1; read every frame. Absent: breathing only. */
  level?: () => number;
}

/** Smooth, deterministic noise in [0, 1) along one axis. */
function noise(seed: number, x: number): number {
  const hash = (n: number) => {
    const h = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453;
    return h - Math.floor(h);
  };
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return hash(i) + (hash(i + 1) - hash(i)) * s;
}

/** One frame: each column's half-height from the eased level, then its dots. */
function drawWave(ctx: CanvasRenderingContext2D, t: number, heard: number[]): void {
  const mid = CANVAS_PX / 2;
  const left = mid - ((COLUMNS - 1) * COLUMN_GAP) / 2;
  for (let c = 0; c < COLUMNS; c++) {
    const fromCenter = (c - (COLUMNS - 1) / 2) / ((COLUMNS - 1) / 2);
    const envelope = Math.exp(-fromCenter * fromCenter * 1.6);
    const breath = 0.2 + 0.08 * Math.sin(t * 2.1 - c * 0.75);
    const voice = heard[c] * envelope * (0.55 + 0.45 * noise(c, t * 5.5));
    const half = (CANVAS_PX / 2 - 1.4) * Math.min(1, breath + voice);
    // The sweep: a band of fuller ink travelling across the columns.
    const depth = 0.5 + 0.5 * Math.sin(t * 2.6 - c * 0.9);
    const x = left + c * COLUMN_GAP;
    const steps = Math.max(0, Math.floor(half / DOT_GAP));
    for (let s = -steps; s <= steps; s++) {
      const tip = steps === 0 ? 0 : Math.abs(s) / steps;
      ctx.globalAlpha = (1 - 0.55 * tip) * (0.55 + 0.45 * depth);
      ctx.beginPath();
      ctx.arc(x, mid + s * DOT_GAP, 1.05 - 0.35 * tip, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Animates the wave on `canvas` until the returned function is called, or
 * until the canvas, once in the document, leaves it (so a canvas handed to
 * ProseMirror as a widget needs no teardown). It draws at ~30 fps and only
 * while it can be seen — on screen, tab visible, not `visibility: hidden` —
 * and reads styles (its ink color, its visibility) rarely, never per frame:
 * a style read can force the whole page's style recalc while the editor
 * is changing under it.
 */
export function mountVoiceWave(canvas: HTMLCanvasElement, options: VoiceWaveOptions = {}): () => void {
  const dpr = Math.min(2, (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1);
  canvas.width = Math.round(CANVAS_PX * dpr);
  canvas.height = Math.round(CANVAS_PX * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  // Per-column level, eased: quick to rise with a syllable, slower to fall.
  const heard = new Array<number>(COLUMNS).fill(0);
  let elapsed = 600;
  let ink = "";
  let inkAt = -Infinity;
  const frame = (dt: number) => {
    const level = Math.min(1, Math.max(0, options.level?.() ?? 0));
    for (let c = 0; c < COLUMNS; c++) {
      const target = level * (0.75 + 0.25 * noise(c + 11, elapsed / 180));
      heard[c] += (target - heard[c]) * Math.min(1, dt / (target > heard[c] ? 60 : 220));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    // Only once it's in the page: a canvas not yet attached (the editor
    // builds its wave before ProseMirror places it) has no color to read,
    // and caching that would leave the first second blank.
    if ((!ink || elapsed - inkAt > 1000) && canvas.isConnected) {
      ink = getComputedStyle(canvas).color;
      inkAt = elapsed;
    }
    ctx.fillStyle = ink;
    drawWave(ctx, elapsed / 1000, heard);
  };
  frame(0);
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }

  let raf = 0;
  let running = false;
  let last = 0;
  const loop = () => {
    const now = performance.now();
    const dt = now - last;
    if (dt >= FRAME_MS) {
      last = now;
      elapsed += dt;
      frame(dt);
    }
    if (running) raf = requestAnimationFrame(loop);
  };
  let visible = true;
  let attached = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  // `visibility: hidden` (a cross-fade's resting state) keeps the canvas in
  // layout, so the observer still calls it visible: check it ourselves, when
  // a cross-fade starts or ends, and as a backstop once a second.
  const styleHidden = () => canvas.checkVisibility?.({ visibilityProperty: true }) === false;
  const sync = () => {
    clearTimeout(poll);
    if (canvas.isConnected) attached = true;
    else if (attached) return stop();
    const hidden = styleHidden();
    const should = visible && !hidden && document.visibilityState !== "hidden";
    if (should && !running) {
      running = true;
      // Drawn at once, not a frame later: it's showing now.
      frame(0);
      last = performance.now();
      raf = requestAnimationFrame(loop);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
    // Also while hidden or offscreen: a canvas removed then fires nothing
    // else, and this is how it notices and lets go.
    poll = setTimeout(sync, 1000);
  };
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          sync();
        })
      : null;
  io?.observe(canvas);
  document.addEventListener("visibilitychange", sync);
  canvas.addEventListener("transitionrun", sync);
  canvas.addEventListener("transitionend", sync);
  if (!io) sync();
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    clearTimeout(poll);
    io?.disconnect();
    document.removeEventListener("visibilitychange", sync);
    canvas.removeEventListener("transitionrun", sync);
    canvas.removeEventListener("transitionend", sync);
  }
  return stop;
}

/** A `<canvas>` with the wave on it, for React. */
export function VoiceWave({
  level,
  size = "0.875rem",
  className,
}: VoiceWaveOptions & { size?: number | string; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(
    () => (ref.current ? mountVoiceWave(ref.current, { level: () => levelRef.current?.() ?? 0 }) : undefined),
    [],
  );
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Listening"
      className={cn("shrink-0", className)}
      // No display here: callers show and hide it with classes.
      style={{ width: size, height: size }}
    />
  );
}
