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

export interface HandoffOptions {
  /**
   * Accept an empty match as rendered. Text is normally the proof that the
   * app has caught up with the snapshot, but a visitor can empty a page —
   * their edits persist — and then an empty editor IS the loaded state.
   * Without this the wait can only end on the timeout, leaving them staring
   * at a stale snapshot they cannot scroll or click for 15 seconds.
   */
  allowEmpty?: boolean;
  timeoutMs?: number;
}

/** Is the app's content on screen, so the snapshot can be dropped? */
export function handoffSatisfied(
  target: Element | null,
  allowEmpty: boolean,
): boolean {
  if (!target) return false;
  if (target instanceof HTMLImageElement) return target.complete;
  return allowEmpty || (target.textContent ?? "").trim().length > 0;
}

/**
 * Mobile waits on the product-shot image (not allowEmpty — img has no text).
 * Desktop waits on the editor, accepting empty when the visitor wiped the page.
 */
export function marketingHandoff(
  isMobileShot: boolean,
  workspaceReady: boolean,
  pageIsEmpty: boolean,
): { selector: string; allowEmpty: boolean } {
  if (isMobileShot) return { selector: ".product-shot", allowEmpty: false };
  if (!workspaceReady) return { selector: ".never", allowEmpty: false };
  return { selector: ".ProseMirror", allowEmpty: pageIsEmpty };
}

/**
 * Remove the overlay once `selector` matches rendered content inside `#root`.
 * Falls back to removing after `timeoutMs` so a selector drift can never
 * leave a visitor stuck behind a stale snapshot.
 */
export function usePrerenderHandoff(
  selector: string | null,
  options: HandoffOptions = {},
): void {
  const { allowEmpty = false, timeoutMs = 15000 } = options;

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
      const target = root?.querySelector(selector) ?? null;
      if (
        handoffSatisfied(target, allowEmpty) ||
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
  }, [selector, allowEmpty, timeoutMs]);
}
