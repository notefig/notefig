/**
 * Pinch-to-zoom, gently (MET-298). A trackpad pinch reaches the page as
 * wheel events with ctrlKey set, dozens of them per gesture, and Tauri's
 * zoom script (`zoomHotkeysEnabled`) zoomed 20% on each one. Here a whole
 * pinch is at most one step between the View menu's zoom levels, taken once
 * it has moved far enough to be deliberate. The platform takes the step
 * (`ui.stepZoom`), so the level persists as a menu choice does; a platform
 * without it (the web) keeps the browser's own pinch.
 */
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";

/** How far a pinch travels (wheel deltaY) before it zooms. */
export const PINCH_STEP_DELTA = 60;
/** A pause this long between a pinch's events ends it. */
export const PINCH_GAP_MS = 300;

/** Turn pinches on `target` into zoom steps, up or down one level. Returns
 *  the stop. */
export function createPinchZoom(target: EventTarget, step: (direction: 1 | -1) => Promise<void>): () => void {
  let travel = 0;
  let stepped = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  const onWheel = (event: Event) => {
    if (!(event instanceof WheelEvent) || !event.ctrlKey) return;
    // The page doesn't scale, and nothing after this sees it: Tauri's
    // script listens on the window, after this capturing listener.
    event.preventDefault();
    event.stopPropagation();
    if (event.timeStamp - lastAt > PINCH_GAP_MS) [travel, stepped] = [0, false];
    lastAt = event.timeStamp;
    if (stepped) return;
    travel += event.deltaY;
    if (Math.abs(travel) < PINCH_STEP_DELTA) return;
    stepped = true;
    // Spreading the fingers scrolls up: zoom in.
    step(travel < 0 ? 1 : -1).catch((error: unknown) => console.error("Failed to zoom:", error));
  };
  target.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => target.removeEventListener("wheel", onWheel, { capture: true });
}

export const pinchZoomModule = defineModule({
  name: "pinch-zoom",
  needs: [platformModule],
  boot: (_api, ctx) => {
    const { ui } = ctx.use("platform");
    if (!ui.stepZoom) return;
    return createPinchZoom(window, (direction) => ui.stepZoom!(direction));
  },
});
