import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useClock } from "./use-clock";

const HOUR = 3_600_000;

describe("useClock", () => {
  let root: Root;
  let latest = 0;

  function Probe() {
    latest = useClock(HOUR);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 6, 14, 59, 30));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("floors to the step and moves on at each boundary", () => {
    act(() => root.render(createElement(Probe)));
    expect(latest).toBe(Date.UTC(2026, 9, 6, 14));

    act(() => vi.advanceTimersByTime(30_000));
    expect(latest).toBe(Date.UTC(2026, 9, 6, 15));

    act(() => vi.advanceTimersByTime(HOUR));
    expect(latest).toBe(Date.UTC(2026, 9, 6, 16));
  });
});
