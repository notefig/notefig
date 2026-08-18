import { useCallback, useEffect, useRef } from "react";

/**
 * Height of the scroll runway that holds the sticky app, in viewport
 * heights. The app pins for `RUNWAY_VH - 100` of scrolling, which is the
 * distance over which it grows from framed-under-the-hero to full screen.
 */
export const RUNWAY_VH = 190;

/** Progress at which the app is close enough to full screen to be live. */
const INTERACTIVE_AT = 0.995;

/** Clamped 0→1 progress of the app's takeover of the viewport. */
export function takeoverProgress(
  runwayTop: number,
  runwayHeight: number,
  viewportHeight: number,
): number {
  const travel = runwayHeight - viewportHeight;
  if (travel <= 0) return 1;
  const progress = -runwayTop / travel;
  if (progress >= INTERACTIVE_AT) return 1; // subpixel rounding must not
  return Math.max(0, progress); //             leave the app 0.999 scaled
}

export interface AppTakeover {
  /** Attach to the runway section that reserves the scroll distance. */
  runwayRef: React.RefObject<HTMLElement | null>;
  /** Attach to the element that owns the `--takeover` custom property. */
  stageRef: React.RefObject<HTMLElement | null>;
  /** Attach to the app frame; held `inert` until the app owns the screen. */
  frameRef: React.RefObject<HTMLElement | null>;
  /** Scroll the app to full screen (smooth) — the "enter the app" gesture. */
  scrollToApp: () => void;
  /** Same destination, no animation — for deep links that start immersed. */
  jumpToApp: () => void;
}

/**
 * Drives the hero → app takeover from the scroll position.
 *
 * Progress is published as the `--takeover` custom property (and a
 * `data-taken-over` flag) on the stage element rather than as React state:
 * the app itself is inside this subtree, and re-rendering the whole
 * workspace on every scroll frame would make the page crawl.
 */
export function useAppTakeover(): AppTakeover {
  const runwayRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let live: boolean | null = null;

    const paint = () => {
      frame = 0;
      const runway = runwayRef.current;
      const stage = stageRef.current;
      if (!runway || !stage) return;
      const rect = runway.getBoundingClientRect();
      const progress = takeoverProgress(
        rect.top,
        rect.height,
        window.innerHeight,
      );
      stage.style.setProperty("--takeover", progress.toFixed(4));

      const takenOver = progress === 1;
      if (takenOver === live) return;
      live = takenOver;
      stage.dataset.takenOver = String(takenOver);
      // `inert` while the app is scenery: it keeps the editor out of the tab
      // order, and — the reason it is load-bearing — stops the editor's
      // mount-time autofocus from scrolling itself into view, which would
      // yank a visitor who just landed straight past the hero.
      frameRef.current?.toggleAttribute("inert", !takenOver);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const scrollTo = useCallback((behavior: ScrollBehavior) => {
    const runway = runwayRef.current;
    if (!runway) return;
    window.scrollTo({
      top: runway.offsetTop + runway.offsetHeight - window.innerHeight,
      behavior,
    });
  }, []);

  return {
    runwayRef,
    stageRef,
    frameRef,
    scrollToApp: useCallback(() => scrollTo("smooth"), [scrollTo]),
    jumpToApp: useCallback(() => scrollTo("auto"), [scrollTo]),
  };
}
