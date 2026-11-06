/**
 * Run `task` once the frame being produced now has painted: the next
 * animation frame, then a macrotask after it. Work that must happen but
 * that nothing on screen waits for (mirroring state into the URL,
 * persisting it) goes here, so it never sits between an input and the
 * frame that answers it. Returns the cancel.
 */
export function afterPaint(task: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(() => {
      if (!cancelled) task();
    }, 0);
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * `afterPaint`, coalesced: however many times `schedule` is called before
 * the task runs, it runs once. `flush` runs a scheduled task now.
 */
export function coalescedAfterPaint(task: () => void, defer = afterPaint) {
  let cancel: (() => void) | null = null;
  const run = () => {
    cancel = null;
    task();
  };
  return {
    schedule() {
      cancel ??= defer(run);
    },
    flush() {
      if (!cancel) return;
      cancel();
      run();
    },
    cancel() {
      cancel?.();
      cancel = null;
    },
  };
}
