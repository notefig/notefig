/**
 * Options for bounded async concurrency pool.
 */
export interface ProcessPoolOptions<TResult> {
  /** Maximum number of concurrent workers */
  concurrency: number;
  /**
   * Called before launching each new worker with the current results array.
   * Return false to stop launching new workers. In-flight workers are
   * allowed to finish, so the final array may grow beyond this point.
   */
  shouldContinue?: (results: TResult[]) => boolean;
}

/**
 * Result from processPool, containing both successful results and errors.
 */
export interface ProcessPoolResult<TResult> {
  /** Flat array of all results from successful workers */
  succeeded: TResult[];
  /** Errors from workers that threw */
  errors: Error[];
}

/**
 * Bounded async concurrency pool.
 *
 * Feeds items from an iterable (sync or async) into up to `concurrency`
 * concurrent workers. Each worker calls `processor(item)` which returns
 * an array of results. Results are collected into a flat array.
 *
 * When `shouldContinue` returns false, no new workers are launched but
 * in-flight ones are allowed to finish. The caller should truncate if needed.
 */
export async function processPool<TItem, TResult>(
  items: AsyncIterable<TItem> | Iterable<TItem>,
  processor: (item: TItem) => Promise<TResult[]>,
  options: ProcessPoolOptions<TResult>,
): Promise<ProcessPoolResult<TResult>> {
  const { concurrency, shouldContinue } = options;
  const succeeded: TResult[] = [];
  const errors: Error[] = [];
  const inFlight = new Set<Promise<void>>();

  // Resolve to async iterable uniformly
  const asyncItems =
    Symbol.asyncIterator in Object(items)
      ? (items as AsyncIterable<TItem>)
      : toAsyncIterable(items as Iterable<TItem>);

  for await (const item of asyncItems) {
    // Stop launching new workers if caller says to stop
    if (shouldContinue && !shouldContinue(succeeded)) {
      break;
    }

    // Wait for a slot if at capacity
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }

    // Check again after awaiting — results may have grown
    if (shouldContinue && !shouldContinue(succeeded)) {
      break;
    }

    const task = processor(item)
      .then((batch) => {
        succeeded.push(...batch);
      })
      .catch((err: unknown) => {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        inFlight.delete(task);
      });

    inFlight.add(task);
  }

  // Wait for remaining in-flight workers
  if (inFlight.size > 0) {
    await Promise.all(inFlight);
  }

  return { succeeded, errors };
}

async function* toAsyncIterable<T>(iter: Iterable<T>): AsyncIterable<T> {
  for (const item of iter) {
    yield item;
  }
}
