import { describe, expect, it, vi } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { createMarkdownMerge, type MarkdownMerge } from "../merge/merge";
import {
  FAILSAFE_COLLISION_SHARE,
  FAILSAFE_MIN_COLLIDED_BLOCKS,
  createSyncMergeDriver,
  defaultMergePolicy,
  failsafeReasonOf,
  overDivergenceThreshold,
  type SyncMergeLog,
} from "./sync-merge-driver";

const merge = createMarkdownMerge(createMarkdownCodec());

function driver(policy = defaultMergePolicy(), load: () => Promise<MarkdownMerge> = async () => merge) {
  const log: SyncMergeLog = { tookRemote: [] };
  const loadMerge = vi.fn(load);
  return { driver: createSyncMergeDriver(policy, loadMerge, log), log, loadMerge, policy };
}

const input = (path: string, base: string | null, ours: string | null, theirs: string | null) => ({
  path,
  base,
  ours,
  theirs,
  holder: "theirs" as const,
});

describe("the sync merge driver", () => {
  it("refuses every file at solo, and never loads the merge", async () => {
    const { driver: d, loadMerge } = driver();
    const out = await d.merge(input("a.md", "x", "y", "z"));
    expect("failed" in out && failsafeReasonOf(out.failed)).toBe("solo");
    const binary = await d.pickBinary!({ path: "a.png", holder: "theirs" });
    expect(typeof binary === "object" && failsafeReasonOf(binary.failed)).toBe("solo");
    expect(loadMerge).not.toHaveBeenCalled();
  });

  it("merges markdown at shared, the branch holding", async () => {
    const { driver: d, policy } = driver();
    policy.merge = true;
    const base = "# T\n\nThe cat sat.\n\nEnd.\n";
    const out = await d.merge(
      input("a.md", base, base.replace("cat", "dog"), base.replace("cat", "cow").replace("End.", "The end.")),
    );
    expect(out).toEqual({ content: "# T\n\nThe cow sat.\n\nThe end.\n", overwritten: ["dog"] });
  });

  it("asks the per-block holder when one is plugged in", async () => {
    const { driver: d, policy } = driver();
    policy.merge = true;
    policy.holderFor = (path) => (path === "leased.md" ? () => "ours" : null);
    const base = "The cat sat.\n";
    const sides = input("leased.md", base, "The dog sat.\n", "The cow sat.\n");
    expect(await d.merge(sides)).toMatchObject({ content: "The dog sat.\n" });
    expect(await d.merge({ ...sides, path: "free.md" })).toMatchObject({ content: "The cow sat.\n" });
  });

  it("keeps an edit against a delete, either way round", async () => {
    const { driver: d, policy } = driver();
    policy.merge = true;
    expect(await d.merge(input("a.md", "x", null, "edited"))).toEqual({ content: "edited", overwritten: [] });
    expect(await d.merge(input("a.md", "x", "edited", null))).toEqual({ content: "edited", overwritten: [] });
  });

  it("lets the remote win any other file, logging it for the recovery ref", async () => {
    const { driver: d, policy, log, loadMerge } = driver();
    policy.merge = true;
    expect(await d.merge(input("data.json", "{}", '{"a":1}', '{"b":2}'))).toEqual({
      content: '{"b":2}',
      overwritten: ['{"a":1}'],
    });
    expect(await d.pickBinary!({ path: "img.png", holder: "theirs" })).toBe("theirs");
    expect(log.tookRemote).toEqual([
      { path: "data.json", binary: false },
      { path: "img.png", binary: true },
    ]);
    expect(loadMerge).not.toHaveBeenCalled();
  });

  it("keeps the local side whole on resume", async () => {
    const { driver: d, policy } = driver();
    policy.keepLocal = true;
    expect(await d.merge(input("a.md", "x", "mine", "theirs"))).toEqual({
      content: "mine",
      overwritten: ["theirs"],
    });
    expect(await d.pickBinary!({ path: "img.png", holder: "ours" })).toBe("ours");
  });

  it("turns a merge that fails validation into the failsafe's reason", async () => {
    const { driver: d, policy } = driver(defaultMergePolicy(), async () => () => ({ failed: "round-trip" }));
    policy.merge = true;
    const out = await d.merge(input("a.md", "x", "y", "z"));
    expect("failed" in out && failsafeReasonOf(out.failed)).toBe("validation");
  });

  it("refuses offline divergence over the threshold, and only when guarding", async () => {
    const base = ["One.", "Two.", "Three.", "Four.", "Five."].join("\n\n");
    const rewrite = (who: string) =>
      base.replace(/(One|Two|Three|Four)\./g, (_, word: string) => `${who}${word.length}.`);
    const { driver: d, policy } = driver();
    policy.merge = true;
    policy.guardDivergence = true;
    const guarded = await d.merge(input("a.md", base, rewrite("me"), rewrite("them")));
    expect("failed" in guarded && failsafeReasonOf(guarded.failed)).toBe("divergence");
    policy.guardDivergence = false;
    expect(await d.merge(input("a.md", base, rewrite("me"), rewrite("them")))).toMatchObject({
      content: `${rewrite("them")}`,
    });
  });

  it("puts the threshold at a share of what changed, with a floor", () => {
    expect(FAILSAFE_COLLISION_SHARE).toBe(0.3);
    expect(overDivergenceThreshold({ theirsChanged: 2, collided: 2 })).toBe(false);
    expect(overDivergenceThreshold({ theirsChanged: 20, collided: FAILSAFE_MIN_COLLIDED_BLOCKS })).toBe(false);
    expect(overDivergenceThreshold({ theirsChanged: 6, collided: 3 })).toBe(true);
  });
});
