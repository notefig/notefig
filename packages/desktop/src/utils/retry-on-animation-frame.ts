export interface RetryOnAnimationFrameOptions {
  maxAttempts?: number;
}

/**
 * Re-run a predicate on animation frames until it succeeds or we hit the cap.
 * Returns a cancel function.
 */
export function retryOnAnimationFrame(
  predicate: () => boolean,
  options: RetryOnAnimationFrameOptions = {},
): () => void {
  const { maxAttempts = 20 } = options;

  let attempt = 0;
  let rafId: number | null = null;
  let cancelled = false;

  const run = () => {
    if (cancelled) return;

    attempt += 1;
    const succeeded = predicate();

    if (succeeded || attempt >= maxAttempts || cancelled) {
      return;
    }

    rafId = requestAnimationFrame(run);
  };

  rafId = requestAnimationFrame(run);

  return () => {
    cancelled = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
  };
}
