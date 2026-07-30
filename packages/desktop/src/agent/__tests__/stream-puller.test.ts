import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
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
});
