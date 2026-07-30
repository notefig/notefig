import { invoke } from "@tauri-apps/api/core";

/** Response shape of the Rust `pull_stream_lines` command (line_stream.rs). */
export type PullResult = { lines: string[]; ended: boolean };

/**
 * Drains one Rust line stream through the `pull_stream_lines` command
 * (MET-98). The Rust side queues lines and emits only payload-free
 * *doorbells*; each doorbell schedules a pull loop here that drains the
 * queue until an empty pull. Because every pull awaits the previous batch's
 * delivery, the webview sets the pace — that is the backpressure that keeps
 * the core process's memory bounded and stops giant frames from ever riding
 * `evaluateJavaScript`.
 *
 * Doorbell/loop coalescing: a doorbell that lands while the loop is running
 * sets a flag the loop re-checks before stopping, so the transition-only
 * doorbell contract (one ring per empty→non-empty, not per line) can't
 * strand lines between a final empty pull and the next ring.
 */
export class StreamPuller {
  private pulling = false;
  private scheduled = false;
  private stopped = false;
  /** True once the Rust side reported end-of-stream (source EOF, fully drained). */
  ended = false;

  constructor(
    private readonly streamId: string,
    private readonly deliver: (line: string) => void,
    private readonly onEnded?: () => void,
  ) {}

  /** Handle one doorbell: start the pull loop, or fold into the running one. */
  schedule(): void {
    if (this.stopped || this.ended) return;
    if (this.pulling) {
      this.scheduled = true;
      return;
    }
    void this.loop();
  }

  /** Stop pulling and delivering (transport closed). Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    this.pulling = true;
    try {
      while (await this.pullRound()) {
        // Each round pulls once and delivers; rounds continue until the
        // queue is drained, the stream ends, or the puller is stopped.
      }
    } finally {
      this.pulling = false;
      if (this.scheduled && !this.stopped && !this.ended) {
        this.scheduled = false;
        void this.loop();
      }
    }
  }

  /** One pull + delivery round. Returns whether the loop should continue. */
  private async pullRound(): Promise<boolean> {
    if (this.stopped) return false;
    let res: PullResult;
    try {
      res = await invoke<PullResult>("pull_stream_lines", {
        streamId: this.streamId,
      });
    } catch {
      // Backend unreachable — the transport's close path reports the real
      // failure; retrying here would spin.
      return false;
    }
    for (const line of res.lines) {
      if (this.stopped) return false;
      this.deliver(line);
    }
    if (res.ended) {
      this.ended = true;
      this.onEnded?.();
      return false;
    }
    if (res.lines.length > 0) return true;
    // Empty pull: the queue looked drained. A doorbell that raced in during
    // this round means a line landed right after the pull — go once more.
    if (!this.scheduled) return false;
    this.scheduled = false;
    return true;
  }
}
