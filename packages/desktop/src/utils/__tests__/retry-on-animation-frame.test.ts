import { describe, it, expect, vi, afterEach } from "vitest";
import { retryOnAnimationFrame } from "../retry-on-animation-frame";

describe("retryOnAnimationFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupRafQueue() {
    const queue: FrameRequestCallback[] = [];
    let nextId = 1;

    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return nextId++;
    });

    return {
      flushNext() {
        const cb = queue.shift();
        cb?.(0);
      },
      flushAll(limit = 20) {
        let count = 0;
        while (queue.length > 0 && count < limit) {
          const cb = queue.shift();
          cb?.(0);
          count += 1;
        }
      },
    };
  }

  it("retries until the predicate succeeds", () => {
    const raf = setupRafQueue();

    let attempts = 0;
    retryOnAnimationFrame(() => {
      attempts += 1;
      return attempts === 3;
    });

    raf.flushAll();

    expect(attempts).toBe(3);
  });

  it("stops after maxAttempts", () => {
    const raf = setupRafQueue();

    let attempts = 0;
    retryOnAnimationFrame(
      () => {
        attempts += 1;
        return false;
      },
      { maxAttempts: 2 },
    );

    raf.flushAll();

    expect(attempts).toBe(2);
  });

  it("cancels scheduled retries", () => {
    const queue: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation(() => {});

    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return 7;
    });

    let attempts = 0;
    const cancel = retryOnAnimationFrame(() => {
      attempts += 1;
      return false;
    });

    cancel();
    queue.shift()?.(0);

    expect(attempts).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
});
