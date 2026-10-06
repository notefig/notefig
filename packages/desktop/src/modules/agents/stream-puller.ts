import { invoke } from "@tauri-apps/api/core";
import { Effect, Fiber, Queue, Schedule, Stream } from "effect";
import { captureError } from "@/telemetry/telemetry";

/** Response shape of the Rust `pull_stream_lines` command (line_stream.rs). */
export type PullResult = { lines: string[]; ended: boolean };

/** Transient pull-failure retry policy. A rejected pull must not abandon the
 * loop: Rust may still have queued data, and because the queue is non-empty
 * there is no future empty→non-empty transition to re-ring the doorbell, so
 * an unretried failure strands that data (truncated agent output / an MCP
 * connection with permanently undelivered requests). */
const MAX_PULL_ATTEMPTS = 5;
const RETRY_BASE_MS = 50;

/**
 * Drains one Rust line stream through the `pull_stream_lines` command
 * (MET-98). The Rust side queues lines and emits only payload-free
 * *doorbells*; each doorbell schedules a pull loop here that drains the
 * queue until an empty pull. Because every pull awaits the previous batch's
 * delivery, the webview sets the pace — that is the backpressure that keeps
 * the core process's memory bounded and stops giant frames from ever riding
 * `evaluateJavaScript`.
 *
 * (MET-72 spike) Implemented over Effect: the doorbell is a single-slot
 * `Queue.sliding(1)` (its coalescing replaces the old `scheduled` flag), a
 * forked fiber consumes it (one drain per ring; a ring that lands mid-drain
 * waits in the queue and drives the next one), and the pull retry is a
 * `Schedule` instead of the hand-rolled backoff loop.
 */
export class StreamPuller {
  private stopped = false;
  /** True once the Rust side reported end-of-stream (source EOF, fully drained). */
  ended = false;

  /** Single-slot doorbell + the fiber draining it; both created on first ring. */
  private doorbell?: Queue.Queue<void>;
  private consumer?: Fiber.RuntimeFiber<void>;

  constructor(
    private readonly streamId: string,
    private readonly deliver: (line: string) => void,
    private readonly onEnded?: () => void,
  ) {}

  /** Handle one doorbell: start the drain fiber (once), then ring. */
  schedule(): void {
    if (this.stopped || this.ended) return;
    if (!this.doorbell) {
      const doorbell = Effect.runSync(Queue.sliding<void>(1));
      this.doorbell = doorbell;
      this.consumer = Effect.runFork(
        Stream.fromQueue(doorbell).pipe(
          Stream.mapEffect(() =>
            // A throwing `deliver` (or `onEnded`) must not kill the sole
            // consumer — it has to survive to drain later doorbells, or all
            // future output/MCP traffic strands (the old loop reset its
            // `pulling` flag in a `finally` for exactly this reason). Catch
            // defects only: `stop()`'s interrupt is a different cause and must
            // still terminate the fiber.
            this.drain().pipe(
              Effect.catchAllDefect((defect) =>
                Effect.sync(() =>
                  // A delivery that throws is a real bug in a downstream
                  // listener — surface it to error tracking rather than
                  // swallowing it, while the fiber lives on for later doorbells.
                  captureError(defect, {
                    boundary: "stream-puller",
                    streamId: this.streamId,
                  }),
                ),
              ),
            ),
          ),
          Stream.runDrain,
        ),
      );
    }
    // Never blocks: a sliding queue drops the extra ring rather than buffering
    // one drain per doorbell.
    Effect.runSync(Queue.offer(this.doorbell, undefined));
  }

  /** Stop pulling and delivering (transport closed). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.consumer) void Effect.runPromise(Fiber.interrupt(this.consumer));
  }

  /** Drain the queue for one doorbell: pull-and-deliver rounds until the queue
   * looks empty, the stream ends, or we're stopped. A doorbell that raced in
   * during the final empty pull is already sitting in the queue, so the fiber
   * simply runs this again — no `scheduled` re-check needed. */
  private drain(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      while (!this.stopped && !this.ended) {
        const res = yield* this.pull();
        if (!res) return; // stopped mid-retry, or every attempt failed
        for (const line of res.lines) {
          if (this.stopped) return; // stop() mid-batch halts the next line
          this.deliver(line);
        }
        if (res.ended) {
          this.ended = true;
          this.onEnded?.();
          return;
        }
        if (res.lines.length === 0) return; // drained; park for the next ring
      }
    });
  }

  /** Pull once, retrying transient rejections with backoff. Resolves to
   * undefined when every attempt failed — the backend is genuinely gone and
   * the transport's close path reports the real failure. */
  private pull(): Effect.Effect<PullResult | undefined> {
    return Effect.tryPromise(() =>
      invoke<PullResult>("pull_stream_lines", { streamId: this.streamId }),
    ).pipe(
      Effect.retry(
        Schedule.linear(`${RETRY_BASE_MS} millis`).pipe(
          Schedule.intersect(Schedule.recurs(MAX_PULL_ATTEMPTS - 1)),
        ),
      ),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
  }
}
