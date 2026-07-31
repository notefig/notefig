export interface ProcessPoolOptions<TResult> {
  concurrency: number;
  /**
   * Called before launching each new worker with the current results array.
   * Return false to stop launching new workers. In-flight workers are
   * allowed to finish, so the final array may grow beyond this point.
   */
  shouldContinue?: (results: TResult[]) => boolean;
}

export interface ProcessPoolResult<TResult> {
  succeeded: TResult[];
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

  const asyncItems =
    Symbol.asyncIterator in Object(items)
      ? (items as AsyncIterable<TItem>)
      : toAsyncIterable(items as Iterable<TItem>);

  for await (const item of asyncItems) {
    if (shouldContinue && !shouldContinue(succeeded)) {
      break;
    }

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
