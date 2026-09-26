import { useEffect, useState, type RefObject } from "react";

/** How often the clock ticks: smooth enough for typing and streaming, cheap
 *  enough that a real editor re-rendering per tick stays fluid. */
const TICK_MS = 40;

/**
 * A looping clock for a scripted demo: milliseconds into a `loopMs` cycle.
 * It runs only while the demo is on screen and restarts from 0 each time it
 * comes back into view. Off screen, before it is ever seen (the prerender)
 * and under reduced motion, it rests at `restMs` — the demo's final state.
 */
export function useDemoClock(
  ref: RefObject<HTMLElement | null>,
  loopMs: number,
  restMs = loopMs - 1,
): number {
  const [elapsed, setElapsed] = useState(restMs);
  const inView = useInView(ref);
  const reduced = usePrefersReducedMotion();
  const play = inView && !reduced;

  useEffect(() => {
    if (!play) {
      setElapsed(restMs);
      return;
    }
    const start = performance.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed((performance.now() - start) % loopMs);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [play, loopMs, restMs]);

  return elapsed;
}

/** How much of `text` has been typed `ms` into typing it at `msPerChar`. */
export function typed(text: string, ms: number, msPerChar: number): string {
  if (ms <= 0) return "";
  return text.slice(0, Math.floor(ms / msPerChar));
}

/**
 * `typed` for markdown being streamed: an unclosed `**` is closed, so a bold
 * phrase renders bold as it streams instead of flashing its raw markers.
 */
export function streamedMarkdown(text: string, ms: number, msPerChar: number): string {
  const partial = typed(text, ms, msPerChar);
  const markers = partial.split("**").length - 1;
  return markers % 2 === 1 ? `${partial}**` : partial;
}

/**
 * A script as consecutive segments: `at(ms)` finds the segment `ms` falls in
 * and hands it the time into that segment.
 */
export function timeline<T>(
  segments: { ms: number; state: (local: number) => T }[],
) {
  const total = segments.reduce((sum, segment) => sum + segment.ms, 0);
  return {
    total,
    at(ms: number): T {
      let start = 0;
      for (const segment of segments) {
        if (ms < start + segment.ms) return segment.state(ms - start);
        start += segment.ms;
      }
      const last = segments[segments.length - 1];
      return last.state(last.ms);
    },
  };
}

function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.3 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
