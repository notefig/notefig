// Voice wave: five rounded bars that rise and fall with the microphone's
// level, in solid `currentColor`, so it takes text color classes and themes
// for free. Until sound reaches the mic the bars sit still as dots; from then
// on, with no input, they keep breathing low, so a working mic never looks
// dead. Animates only while visible; reduced-motion users get a still frame.
//
// Drawn on a canvas sized to its real device pixels, with the bars snapped
// to them: sharp at any size, and a frame changes no DOM. That matters inside
// an editor, where every DOM change costs a style and layout pass and, in
// WebKit, a caret repaint — 30 times a second, for the whole document.
//
// Framework-free at its core (`mountVoiceWave`), because the editor draws it
// inside a ProseMirror decoration; `VoiceWave` wraps it for React.

import { useEffect, useRef } from "react";
import { cn } from "./utils";

/** The bars are laid out in a VIEW × VIEW box, scaled to the canvas. */
const VIEW = 20;
const BARS = 5;
const BAR_WIDTH = 2.4;
const BAR_GAP = 1.5;
/** Shortest a bar gets: a dot. */
const MIN_HEIGHT = BAR_WIDTH;
const MAX_HEIGHT = 16;
/** The middle bars reach higher than the outer ones. */
const REACH = [0.55, 0.8, 1, 0.8, 0.55];
/** ~30 fps: plenty for a wave this size. */
const FRAME_MS = 32;

export interface VoiceWaveOptions {
  /** The input level now, 0–1; read every frame. Absent: breathing only. */
  level?: () => number;
  /** Whether sound is reaching the mic yet; read every frame. Absent: yes. */
  hearing?: () => boolean;
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

/** A rounded bar, in device pixels. */
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + r, y + h - r, r, 0, Math.PI);
  ctx.closePath();
  ctx.fill();
}

/**
 * Animates the wave on `canvas` until the returned function is called, or
 * until the canvas leaves the page while animating. It draws at ~30 fps and
 * only while it can be seen — on screen, tab visible, not `visibility:
 * hidden` — and costs nothing while it can't.
 */
export function mountVoiceWave(canvas: HTMLCanvasElement, options: VoiceWaveOptions = {}): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  // The ink is the canvas's CSS color, read rarely (a style read can force
  // the page's style recalc) and only once it's in the page: detached, it
  // has none.
  let ink = "";
  let inkAt = -Infinity;
  const readInk = () => {
    if (!canvas.isConnected) return;
    ink = getComputedStyle(canvas).color;
    inkAt = performance.now();
  };

  // Per-bar level, eased: quick to rise with a syllable, slower to fall.
  const heard = new Array<number>(BARS).fill(0);
  let elapsed = 600;
  const frame = (dt: number) => {
    const hearing = options.hearing?.() ?? true;
    const level = hearing ? Math.min(1, Math.max(0, options.level?.() ?? 0)) : 0;
    const t = elapsed / 1000;
    const { width, height } = canvas;
    if (!width || !height) return;
    if (!ink || performance.now() - inkAt > 1000) readInk();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = ink;
    // Snapped to whole device pixels, so edges don't blur.
    const scale = Math.min(width, height) / VIEW;
    const barWidth = Math.max(1, Math.round(BAR_WIDTH * scale));
    const gap = Math.max(1, Math.round(BAR_GAP * scale));
    const left = Math.round((width - (BARS * barWidth + (BARS - 1) * gap)) / 2);
    for (let b = 0; b < BARS; b++) {
      const target = level * (0.6 + 0.4 * noise(b + 11, elapsed / 140));
      heard[b] += (target - heard[b]) * Math.min(1, dt / (target > heard[b] ? 50 : 200));
      const breath = hearing ? 0.08 + 0.06 * Math.sin(t * 2.4 - b * 0.8) : 0;
      const reach = Math.min(1, breath + heard[b]) * REACH[b];
      const h = Math.max(barWidth, Math.round((MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * reach) * scale));
      bar(ctx, left + b * (barWidth + gap), Math.round((height - h) / 2), barWidth, h);
    }
  };

  // The backing store follows the canvas's size on screen, in device pixels.
  const resize = (cssWidth: number, cssHeight: number) => {
    const dpr = (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1;
    const w = Math.round(cssWidth * dpr);
    const h = Math.round(cssHeight * dpr);
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    frame(0);
  };
  const sizes =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(([entry]) => {
          const box = entry.contentBoxSize?.[0];
          resize(box?.inlineSize ?? entry.contentRect.width, box?.blockSize ?? entry.contentRect.height);
        })
      : null;
  sizes?.observe(canvas);
  frame(0);
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => sizes?.disconnect();
  }

  let raf = 0;
  let running = false;
  let last = 0;
  const loop = () => {
    // Taken out of the page while running (an editor widget's DOM can go
    // without a word): let go.
    if (!canvas.isConnected) return stop();
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
  // `visibility: hidden` (a cross-fade's resting state) keeps the element in
  // layout, so the observer still calls it visible: check it ourselves, when
  // a cross-fade starts or ends. Only then — never on a timer: composers keep
  // a hidden wave mounted all session, and a style read is not free.
  const styleHidden = () => canvas.checkVisibility?.({ visibilityProperty: true }) === false;
  const sync = () => {
    const hidden = styleHidden();
    const should = visible && !hidden && document.visibilityState !== "hidden";
    if (should && !running) {
      running = true;
      // Shown again, perhaps on another background: its color may differ.
      readInk();
      last = performance.now();
      raf = requestAnimationFrame(loop);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
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
    io?.disconnect();
    sizes?.disconnect();
    document.removeEventListener("visibilitychange", sync);
    canvas.removeEventListener("transitionrun", sync);
    canvas.removeEventListener("transitionend", sync);
  }
  return stop;
}

/** A `<canvas>` with the wave on it, for React. */
export function VoiceWave({
  level,
  hearing,
  size = "0.875rem",
  className,
}: VoiceWaveOptions & { size?: number | string; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ level, hearing });
  latest.current = { level, hearing };
  useEffect(
    () =>
      ref.current
        ? mountVoiceWave(ref.current, {
            level: () => latest.current.level?.() ?? 0,
            hearing: () => latest.current.hearing?.() ?? true,
          })
        : undefined,
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
