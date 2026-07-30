// Retry an async operation with bounded attempts and backoff.

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Maximum attempts, including the first. Must be >= 1. */
  attempts: number;
  /**
   * Backoff before the retry that follows a failed attempt `n` (0-indexed:
   * `n = 0` is the wait after the first attempt fails). Return milliseconds.
   * Defaults to a flat 0ms (retry immediately).
   */
  backoffMs?: (attempt: number) => number;
  /**
   * Consulted before every attempt (including the first). Returning true
   * aborts with the `aborted` outcome — for callers whose work becomes moot
   * mid-retry (e.g. a closed transport).
   */
  aborted?: () => boolean;
}

/**
 * The result of {@link retry}. Discriminated so a legitimately-undefined
 * success value is never confused with failure.
 */
export type RetryOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "aborted" }
  | { status: "exhausted"; error: unknown };

/**
 * Run `fn`, retrying on rejection up to `attempts` times with backoff between
 * tries. Stops early — without consuming an attempt — whenever `aborted()`
 * returns true.
 *
 * Returns an outcome rather than throwing or returning a bare `undefined`, so
 * callers can tell "gave up after N failures" from "was cancelled" from a
 * real value.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const { attempts, backoffMs, aborted } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (aborted?.()) return { status: "aborted" };
    try {
      return { status: "ok", value: await fn() };
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (!isLast) await delay(backoffMs?.(attempt) ?? 0);
    }
  }
  return { status: "exhausted", error: lastError };
}
