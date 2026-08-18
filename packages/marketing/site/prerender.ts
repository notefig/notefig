/**
 * Prerender handoff. Prerendered pages ship a `#prerender` overlay (a DOM
 * snapshot of this same route) painted above `#root`. The live app removes it
 * once the route's real content is on screen — replace, not hydrate, so
 * there is never a React hydration mismatch to manage.
 */
import { useEffect } from "react";

export const MARKETING_READY_ATTRIBUTE = "data-marketing-ready";

function markReady(): void {
  document.documentElement.setAttribute(MARKETING_READY_ATTRIBUTE, "true");
  document.getElementById("prerender")?.remove();
}

/**
 * Remove the overlay when `selector` matches an element with visible text
 * inside `#root`. Falls back to removing after `timeoutMs` so a selector
 * drift can never leave a visitor stuck behind a stale snapshot.
 */
export function usePrerenderHandoff(
  selector: string | null,
  timeoutMs = 15000,
): void {
  useEffect(() => {
    if (!document.getElementById("prerender")) {
      markReady();
      return;
    }
    if (selector === null) {
      markReady();
      return;
    }

    let cancelled = false;
    const startedAt = performance.now();

    const poll = () => {
      if (cancelled) return;
      const root = document.getElementById("root");
      const target = root?.querySelector(selector);
      if (
        (target && (target.textContent ?? "").trim().length > 0) ||
        performance.now() - startedAt > timeoutMs
      ) {
        markReady();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);

    return () => {
      cancelled = true;
    };
  }, [selector, timeoutMs]);
}
