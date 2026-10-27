// Voice wave: five rounded bars that rise and fall with the microphone's
// level. Vector (SVG) and solid `currentColor`, so it's sharp at any size and
// takes text color classes and themes for free. With no input the bars keep
// breathing low, so an open mic never looks dead. Animates only while
// visible; reduced-motion users get a still frame.
//
// Framework-free at its core (`mountVoiceWave`), because the editor draws it
// inside a ProseMirror decoration; `VoiceWave` wraps it for React.

import { useEffect, useRef } from "react";
import { cn } from "./utils";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The viewBox is VIEW × VIEW; the bars are laid out in its units. */
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

/**
 * Animates the wave in `svg` until the returned function is called, or
 * until the element, once in the document, leaves it (so one handed to
 * ProseMirror as a widget needs no teardown). It draws at ~30 fps and only
 * while it can be seen — on screen, tab visible, not `visibility: hidden`.
 */
export function mountVoiceWave(svg: SVGSVGElement, options: VoiceWaveOptions = {}): () => void {
  svg.setAttribute("viewBox", `0 0 ${VIEW} ${VIEW}`);
  svg.setAttribute("fill", "currentColor");
  // Its own bars only, if it was mounted before (React remounts in dev).
  svg.replaceChildren();
  const left = (VIEW - (BARS * BAR_WIDTH + (BARS - 1) * BAR_GAP)) / 2;
  const bars = REACH.map((_, b) => {
    const bar = document.createElementNS(SVG_NS, "rect");
    bar.setAttribute("x", String(left + b * (BAR_WIDTH + BAR_GAP)));
    bar.setAttribute("width", String(BAR_WIDTH));
    bar.setAttribute("rx", String(BAR_WIDTH / 2));
    svg.append(bar);
    return bar;
  });

  // Per-bar level, eased: quick to rise with a syllable, slower to fall.
  const heard = new Array<number>(BARS).fill(0);
  let elapsed = 600;
  const frame = (dt: number) => {
    const level = Math.min(1, Math.max(0, options.level?.() ?? 0));
    const t = elapsed / 1000;
    bars.forEach((bar, b) => {
      const target = level * (0.6 + 0.4 * noise(b + 11, elapsed / 140));
      heard[b] += (target - heard[b]) * Math.min(1, dt / (target > heard[b] ? 50 : 200));
      const breath = 0.08 + 0.06 * Math.sin(t * 2.4 - b * 0.8);
      const reach = Math.min(1, breath + heard[b]) * REACH[b];
      const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * reach;
      bar.setAttribute("y", ((VIEW - height) / 2).toFixed(2));
      bar.setAttribute("height", height.toFixed(2));
    });
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
  // `visibility: hidden` (a cross-fade's resting state) keeps the element in
  // layout, so the observer still calls it visible: check it ourselves, when
  // a cross-fade starts or ends, and as a backstop once a second.
  const styleHidden = () => svg.checkVisibility?.({ visibilityProperty: true }) === false;
  const sync = () => {
    clearTimeout(poll);
    if (svg.isConnected) attached = true;
    else if (attached) return stop();
    const hidden = styleHidden();
    const should = visible && !hidden && document.visibilityState !== "hidden";
    if (should && !running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
    // Also while hidden or offscreen: an element removed then fires nothing
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
  io?.observe(svg);
  document.addEventListener("visibilitychange", sync);
  svg.addEventListener("transitionrun", sync);
  svg.addEventListener("transitionend", sync);
  if (!io) sync();
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    clearTimeout(poll);
    io?.disconnect();
    document.removeEventListener("visibilitychange", sync);
    svg.removeEventListener("transitionrun", sync);
    svg.removeEventListener("transitionend", sync);
  }
  return stop;
}

/** An `<svg>` with the wave in it, for React. */
export function VoiceWave({
  level,
  size = "0.875rem",
  className,
}: VoiceWaveOptions & { size?: number | string; className?: string }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(
    () => (ref.current ? mountVoiceWave(ref.current, { level: () => levelRef.current?.() ?? 0 }) : undefined),
    [],
  );
  return (
    <svg
      ref={ref}
      role="img"
      aria-label="Listening"
      className={cn("shrink-0", className)}
      // No display here: callers show and hide it with classes.
      style={{ width: size, height: size }}
    />
  );
}
