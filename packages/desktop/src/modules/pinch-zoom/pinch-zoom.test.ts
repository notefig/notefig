import { describe, expect, it, vi } from "vitest";
import { PINCH_GAP_MS, PINCH_STEP_DELTA, createPinchZoom } from "./pinch-zoom";

/** A wheel event at `at` ms; a pinch is one with ctrlKey set. */
function wheel(deltaY: number, at: number, ctrlKey = true): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  // jsdom's WheelEvent drops ctrlKey from its init, and stamps the real time.
  Object.defineProperties(event, { ctrlKey: { value: ctrlKey }, timeStamp: { value: at } });
  return event;
}

function pinchOn() {
  const page = document.createElement("div");
  document.body.append(page);
  const step = vi.fn(async (_direction: 1 | -1) => {});
  const stop = createPinchZoom(window, step);
  return { page, step, stop };
}

describe("pinch zoom", () => {
  it("steps once per pinch, once it has travelled far enough, and the page never sees it", () => {
    const { page, step, stop } = pinchOn();
    const reached = vi.fn();
    page.addEventListener("wheel", reached);
    const half = PINCH_STEP_DELTA / 2;

    page.dispatchEvent(wheel(half, 0));
    expect(step).not.toHaveBeenCalled();
    const far = wheel(half, 10);
    page.dispatchEvent(far);
    page.dispatchEvent(wheel(PINCH_STEP_DELTA, 20));
    // Fingers together: down one level, and only once in the gesture.
    expect(step.mock.calls).toEqual([[-1]]);
    expect(far.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    stop();
  });

  it("starts a new pinch after a pause, and zooms in as the fingers spread", () => {
    const { page, step, stop } = pinchOn();
    page.dispatchEvent(wheel(PINCH_STEP_DELTA, 0));
    page.dispatchEvent(wheel(-PINCH_STEP_DELTA, PINCH_GAP_MS + 1));
    expect(step.mock.calls).toEqual([[-1], [1]]);
    stop();
  });

  it("leaves a plain scroll alone", () => {
    const { page, step, stop } = pinchOn();
    const scroll = wheel(PINCH_STEP_DELTA, 0, false);
    page.dispatchEvent(scroll);
    expect(step).not.toHaveBeenCalled();
    expect(scroll.defaultPrevented).toBe(false);
    stop();
  });
});
