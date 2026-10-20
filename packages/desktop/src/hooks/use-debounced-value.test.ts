import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebouncedValue } from "./use-debounced-value";

// Minimal harness: just read the exported hook's return value. We can't call
// it outside React, but we can assert it exists and has the expected arity.
describe("useDebouncedValue", () => {
  it("is a hook that takes a value and a delay", () => {
    expect(typeof useDebouncedValue).toBe("function");
    expect(useDebouncedValue.length).toBe(2);
  });
});

// React integration test: the hook is exercised through a tiny component
// rendered with React's test renderer pattern used elsewhere in the app.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

describe("useDebouncedValue integration", () => {
  let root: Root;
  let latest = "";

  function Probe({ value }: { value: string }) {
    latest = useDebouncedValue(value, 100);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    latest = "";
    root = createRoot(document.createElement("div"));
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    act(() => root.render(createElement(Probe, { value: "first" })));
    expect(latest).toBe("first");
  });

  it("delays updates until the debounce window passes", () => {
    act(() => root.render(createElement(Probe, { value: "first" })));
    expect(latest).toBe("first");

    act(() => root.render(createElement(Probe, { value: "second" })));
    expect(latest).toBe("first");

    act(() => vi.advanceTimersByTime(50));
    expect(latest).toBe("first");

    act(() => vi.advanceTimersByTime(80));
    expect(latest).toBe("second");
  });

  it("resets the timer on rapid changes so only the last value lands", () => {
    act(() => root.render(createElement(Probe, { value: "a" })));

    act(() => root.render(createElement(Probe, { value: "ab" })));
    act(() => vi.advanceTimersByTime(80));
    expect(latest).toBe("a");

    act(() => root.render(createElement(Probe, { value: "abc" })));
    act(() => vi.advanceTimersByTime(80));
    // 80 + 80 = 160ms from the first change would have fired "ab", but the
    // reset for "abc" keeps the value at "a".
    expect(latest).toBe("a");

    act(() => vi.advanceTimersByTime(30));
    expect(latest).toBe("abc");
  });
});
