import { useEffect, useState } from "react";

function floorTo(stepMs: number): number {
  return Math.floor(Date.now() / stepMs) * stepMs;
}

/** The current time, floored to `stepMs` and advanced at each boundary — a
 *  clock for views that stay open: a component re-renders once per step,
 *  and anything memoized on the value recomputes only when it moves. */
export function useClock(stepMs: number): number {
  const [now, setNow] = useState(() => floorTo(stepMs));
  useEffect(() => {
    // At least one step on, even if the timer fires a hair early.
    const timer = setTimeout(
      () => setNow(Math.max(floorTo(stepMs), now + stepMs)),
      now + stepMs - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [now, stepMs]);
  return now;
}
