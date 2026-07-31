import { Effect, Stream } from "effect";

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
 *
 * (MET-72 spike) Implemented over Effect's `Stream`: the iterable becomes a
 * stream, `takeWhile` is the `shouldContinue` gate, and `mapEffect`'s
 * `concurrency` option replaces the hand-rolled `Set<Promise>` + `Promise.race`
 * bounding. Errors are caught per-item so one failure never aborts the pool.
 */
export async function processPool<TItem, TResult>(
  items: AsyncIterable<TItem> | Iterable<TItem>,
  processor: (item: TItem) => Promise<TResult[]>,
  options: ProcessPoolOptions<TResult>,
): Promise<ProcessPoolResult<TResult>> {
  const { concurrency, shouldContinue } = options;
  const succeeded: TResult[] = [];
  const errors: Error[] = [];

  const source =
    Symbol.asyncIterator in Object(items)
      ? Stream.fromAsyncIterable(items as AsyncIterable<TItem>, toError)
      : Stream.fromIterable(items as Iterable<TItem>);

  const program = source.pipe(
    // One element per chunk. Without this, `fromIterable` emits a single chunk
    // of every item and the `takeWhile` below evaluates against an unchanged
    // `succeeded` for the whole batch — the stateful gate would never fire.
    Stream.rechunk(1),
    // Gate before each item reaches a worker. `takeWhile` drops the first item
    // that fails the predicate and ends the stream, so no further workers
    // launch — while any already past this gate run to completion.
    Stream.takeWhile(() => !shouldContinue || shouldContinue(succeeded)),
    Stream.mapEffect(
      (item) =>
        Effect.tryPromise({ try: () => processor(item), catch: toError }).pipe(
          Effect.match({
            onSuccess: (batch) => succeeded.push(...batch),
            onFailure: (error) => errors.push(error),
          }),
        ),
      { concurrency },
    ),
    Stream.runDrain,
  );

  await Effect.runPromise(program);
  return { succeeded, errors };
}

const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));
