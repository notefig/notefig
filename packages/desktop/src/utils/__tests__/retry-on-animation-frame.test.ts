import { describe, it, expect, vi, afterEach } from "vitest";
import { retryOnAnimationFrame } from "../retry-on-animation-frame";

describe("retryOnAnimationFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries until the predicate succeeds", () => {
    let callback: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      callback = cb;
      return 1;
    });

    let attempts = 0;
    retryOnAnimationFrame(() => {
      attempts += 1;
      return attempts === 3;
    });

    callback?.(0);
    callback?.(0);
    callback?.(0);

    expect(attempts).toBe(3);
  });

  it("stops after maxAttempts", () => {
    let callback: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      callback = cb;
      return 1;
    });

    let attempts = 0;
    retryOnAnimationFrame(
      () => {
        attempts += 1;
        return false;
      },
      { maxAttempts: 2 },
    );

    callback?.(0);
    callback?.(0);
    callback?.(0);

    expect(attempts).toBe(2);
  });

  it("cancels scheduled retries", () => {
    let callback: FrameRequestCallback | undefined;
    const cancelAnimationFrame = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation(() => {});

    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      callback = cb;
      return 7;
    });

    let attempts = 0;
    const cancel = retryOnAnimationFrame(() => {
      attempts += 1;
      return false;
    });

    cancel();
    callback?.(0);

    expect(attempts).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
});
