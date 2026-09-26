import { useEffect, useState, type RefObject } from "react";

/**
 * Steps a demo through its frames: `durations[i]` is how long frame i holds
 * before the next, and the last frame loops back to the first. Runs only
 * while the demo is on screen; with reduced motion (or before it is ever
 * seen, e.g. in the prerender) it rests on `restFrame`.
 */
export function useDemoScript(
  ref: RefObject<HTMLElement | null>,
  durations: number[],
  restFrame = durations.length - 1,
): number {
  const [frame, setFrame] = useState(restFrame);
  const inView = useInView(ref);
  const reduced = usePrefersReducedMotion();
  const play = inView && !reduced;

  useEffect(() => {
    if (!play) {
      setFrame(restFrame);
      return;
    }
    let current = 0;
    setFrame(0);
    let timer = window.setTimeout(function advance() {
      current = (current + 1) % durations.length;
      setFrame(current);
      timer = window.setTimeout(advance, durations[current]);
    }, durations[0]);
    return () => window.clearTimeout(timer);
    // durations are module constants per demo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, restFrame]);

  return frame;
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
