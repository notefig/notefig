import { describe, expect, it } from "vitest";
import { alignBlocks } from "./merge/blocks";
import {
  LEASE_IDLE_MS,
  LEASE_MAX_BLOCKS,
  LEASE_STALE_MS,
  changeNeeds,
  changeStretches,
  decideLease,
  describeBlocks,
  isLeaseStale,
  releaseIdle,
  withNeighbours,
  type CurrentLease,
  type LeaseHolder,
} from "./lease-rules";

const ada: LeaseHolder = { id: "dev-a", kind: "human", deviceId: "dev-a", name: "Ada", color: "#8e4ec6" };
const adaAgent: LeaseHolder = {
  id: "dev-a/task-1",
  kind: "agent",
  deviceId: "dev-a",
  name: "Ada",
  color: "#8e4ec6",
  taskId: "task-1",
  harness: "claude",
};
const bo: LeaseHolder = { id: "dev-b", kind: "human", deviceId: "dev-b", name: "Bo", color: "#46a758" };
const boAgent: LeaseHolder = { ...adaAgent, id: "dev-b/task-9", deviceId: "dev-b", name: "Bo", taskId: "task-9" };

const lease = (holder: LeaseHolder, blocks: number[], stale = false): CurrentLease => ({
  holder,
  blocks,
  stale,
});

/** What a change between two block lists needs. */
const needs = (from: string[], to: string[]) =>
  changeNeeds(changeStretches(alignBlocks(from, to), to.length), from.length, to.length);

describe("decideLease", () => {
  it("grants free blocks, adding to what the holder already holds", () => {
    const decision = decideLease({ holder: ada, needed: [4], leases: [lease(ada, [1, 2]), lease(bo, [7])] });
    expect(decision).toEqual({ granted: true, blocks: [1, 2, 4], takeovers: [] });
  });

  it("is all or nothing: one block another holder leases refuses the whole change, naming them", () => {
    const decision = decideLease({ holder: ada, needed: [1, 2, 3], leases: [lease(bo, [3, 8])] });
    expect(decision).toEqual({ granted: false, reason: "held", holders: [bo], blocks: [3] });
  });

  it("names every holder in the way once, people and agents alike", () => {
    const decision = decideLease({
      holder: ada,
      needed: [0, 1, 2, 3],
      leases: [lease(bo, [0]), lease(boAgent, [2, 3]), lease(bo, [1])],
    });
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.holders.map((h) => h.id)).toEqual(["dev-b", "dev-b/task-9"]);
  });

  it("caps the blocks one holder leases, counting what it holds", () => {
    const held = Array.from({ length: LEASE_MAX_BLOCKS - 1 }, (_, i) => i);
    expect(decideLease({ holder: ada, needed: [30], leases: [lease(ada, held)] }).granted).toBe(true);
    expect(decideLease({ holder: ada, needed: [30, 31], leases: [lease(ada, held)] })).toEqual({
      granted: false,
      reason: "cap",
      holders: [ada],
      blocks: [30, 31],
    });
    // Re-touching blocks it already holds never counts twice.
    expect(decideLease({ holder: ada, needed: [0, 1], leases: [lease(ada, held)] }).granted).toBe(true);
  });

  it("takes over a lease only once it was observed stale, and says whose ref to delete", () => {
    const live = decideLease({ holder: ada, needed: [5], leases: [lease(bo, [5])] });
    expect(live.granted).toBe(false);
    const stale = lease(bo, [5, 6], true);
    expect(decideLease({ holder: ada, needed: [5], leases: [stale] })).toEqual({
      granted: true,
      blocks: [5],
      takeovers: [stale],
    });
    // A stale lease that doesn't overlap is left alone.
    expect(decideLease({ holder: ada, needed: [1], leases: [stale] })).toMatchObject({ takeovers: [] });
  });

  it("is the same function for people and agents: an agent is refused by its own person's lease", () => {
    // The person's agent is a separate holder (decision 8).
    const agentFirst = decideLease({ holder: adaAgent, needed: [2], leases: [lease(ada, [2])] });
    expect(agentFirst).toMatchObject({ granted: false, holders: [ada] });
    const personFirst = decideLease({ holder: ada, needed: [2], leases: [lease(adaAgent, [2])] });
    expect(personFirst).toMatchObject({ granted: false, holders: [adaAgent] });
  });
});

describe("what a change needs", () => {
  const doc = ["# Title", "One.", "Two.", "Three.", "Four."];

  it("an edit inside a block needs only that block", () => {
    expect(needs(doc, ["# Title", "One.", "Two!", "Three.", "Four."])).toEqual({
      needed: [2],
      result: [2],
    });
  });

  it("an insert needs the blocks either side, and leases the new block with them", () => {
    expect(needs(doc, ["# Title", "One.", "New.", "Two.", "Three.", "Four."])).toEqual({
      needed: [1, 2],
      result: [1, 2, 3],
    });
  });

  it("a delete needs the block and its neighbours", () => {
    expect(needs(doc, ["# Title", "One.", "Three.", "Four."])).toEqual({
      needed: [1, 2, 3],
      result: [1, 2],
    });
  });

  it("a move is a delete plus an insert: both places and their neighbours", () => {
    const moved = ["# Title", "Two.", "Three.", "One.", "Four."];
    const { needed } = needs(doc, moved);
    expect(needed).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it("a whole-file rewrite needs every block", () => {
    const rewrite = doc.map((block) => `${block} (rewritten)`);
    expect(needs(doc, rewrite).needed).toEqual([0, 1, 2, 3, 4]);
  });

  it("is the same from the same pair of versions on every client", () => {
    const next = ["# Title", "One!", "Two.", "Extra.", "Three.", "Four."];
    expect(needs([...doc], [...next])).toEqual(needs(doc, next));
  });

  it("withNeighbours clips to the document and covers insert gaps", () => {
    expect(withNeighbours([0], 3)).toEqual([0, 1]);
    expect(withNeighbours([], 3, [3])).toEqual([2]);
    expect(withNeighbours([], 3, [1])).toEqual([0, 1]);
  });
});

describe("idle expiry and staleness", () => {
  it("a holder keeps only the blocks it touched within the idle time", () => {
    const now = 100_000;
    const kept = releaseIdle(
      [
        { index: 1, touchedAt: now - 1_000 },
        { index: 2, touchedAt: now - LEASE_IDLE_MS },
        { index: 3, touchedAt: now - LEASE_IDLE_MS + 1 },
      ],
      now,
    );
    expect(kept.map((block) => block.index)).toEqual([1, 3]);
  });

  it("staleness is the local observation of the ref moving, never a payload time", () => {
    expect(isLeaseStale(null, 5)).toBe(true);
    expect(isLeaseStale(1_000, 1_000 + LEASE_STALE_MS - 1)).toBe(false);
    expect(isLeaseStale(1_000, 1_000 + LEASE_STALE_MS)).toBe(true);
  });

  it("describes blocks for people", () => {
    expect(describeBlocks([2])).toBe("3");
    expect(describeBlocks([1, 2, 3, 6])).toBe("2–4 and 7");
  });
});
