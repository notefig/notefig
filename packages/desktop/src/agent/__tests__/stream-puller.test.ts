import { describe, expect, it, vi } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";

const { captureError } = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/telemetry/telemetry", () => ({ captureError }));

import { StreamPuller, type PullResult } from "../stream-puller";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("StreamPuller", () => {
  it("a doorbell during the loop re-arms it — the lost-wakeup race can't strand lines", async () => {
    // The Rust side rings only on the empty→non-empty transition. The
    // dangerous interleaving: the loop's last pull sees an empty queue, and
    // a line lands (with its doorbell) BEFORE the loop exits. If that
    // doorbell were ignored because "a loop is running", no further ring
    // would ever come — the queue is non-empty now, so there is no next
    // transition. The puller must fold the raced doorbell into one more
    // pull round.
    const responses: PullResult[] = [
      { lines: ["first"], ended: false },
      { lines: [], ended: false }, // the "empty" pull the race hides behind
      { lines: ["raced"], ended: true },
    ];
    let puller: StreamPuller;
    let pulls = 0;
    withMockedTauri({
      pull_stream_lines: () => {
        pulls += 1;
        if (pulls === 2) {
          // The line + doorbell land while this (empty) pull is in flight.
          puller.schedule();
        }
        return responses.shift() ?? { lines: [], ended: false };
      },
    });

    const delivered: string[] = [];
    let endedCalls = 0;
    puller = new StreamPuller(
      "s1",
      (line) => delivered.push(line),
      () => (endedCalls += 1),
    );

    puller.schedule();
    await flush();

    expect(delivered).toEqual(["first", "raced"]);
    expect(puller.ended).toBe(true);
    expect(endedCalls).toBe(1);
  });

  it("coalesces doorbells: many rings while draining cost no extra pull rounds", async () => {
    let pulls = 0;
    withMockedTauri({
      pull_stream_lines: (): PullResult => {
        pulls += 1;
        return pulls === 1
          ? { lines: ["a", "b"], ended: false }
          : { lines: [], ended: false };
      },
    });

    const puller = new StreamPuller("s2", () => {});
    puller.schedule();
    puller.schedule();
    puller.schedule();
    await flush();

    // One data pull + one empty pull for the coalesced re-check — not one
    // round per doorbell.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("recovers from a transient pull rejection instead of stranding queued lines", async () => {
    // The P1 from PR #154 review: a rejected pull with data still queued
    // Rust-side must not kill the only loop — no further transition doorbell
    // will come (the queue is non-empty), so the loop must retry and deliver.
    let calls = 0;
    withMockedTauri({
      pull_stream_lines: (): PullResult => {
        calls += 1;
        if (calls === 1) throw new Error("transient IPC failure");
        if (calls === 2) return { lines: ["recovered"], ended: true };
        return { lines: [], ended: true };
      },
    });

    const delivered: string[] = [];
    const puller = new StreamPuller("s-retry", (line) => delivered.push(line));
    puller.schedule();

    // Wait past the first retry backoff (RETRY_BASE_MS = 50ms).
    await new Promise((r) => setTimeout(r, 120));

    expect(delivered).toEqual(["recovered"]);
    expect(puller.ended).toBe(true);
  });

  it("stop() halts delivery even mid-batch", async () => {
    let puller: StreamPuller;
    withMockedTauri({
      pull_stream_lines: (): PullResult => ({
        lines: ["one", "two", "three"],
        ended: false,
      }),
    });

    const delivered: string[] = [];
    puller = new StreamPuller("s3", (line) => {
      delivered.push(line);
      if (line === "two") puller.stop();
    });

    puller.schedule();
    await flush();

    expect(delivered).toEqual(["one", "two"]);
  });

  it("survives a throwing line listener — a later doorbell still delivers, and the error is tracked (PR #157)", async () => {
    // A delivery that throws must not permanently kill the consumer fiber; the
    // next doorbell has to keep draining, or all subsequent output strands.
    captureError.mockClear();
    const responses: PullResult[] = [
      { lines: ["boom"], ended: false }, // drain #1: this delivery throws
      { lines: ["after"], ended: false }, // drain #2 (next doorbell): must run
      { lines: [], ended: false },
    ];
    withMockedTauri({
      pull_stream_lines: () => responses.shift() ?? { lines: [], ended: false },
    });

    const delivered: string[] = [];
    const puller = new StreamPuller("s-throw", (line) => {
      if (line === "boom") throw new Error("listener blew up");
      delivered.push(line);
    });

    puller.schedule();
    await flush();
    // First drain died on "boom"; ring again — a dead consumer would strand this.
    puller.schedule();
    await flush();

    expect(delivered).toEqual(["after"]);
    // The swallowed defect is surfaced to error tracking, not lost.
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener blew up" }),
      { boundary: "stream-puller", streamId: "s-throw" },
    );
  });
});
