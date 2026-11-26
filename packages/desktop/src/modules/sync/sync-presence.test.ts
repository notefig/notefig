import { describe, expect, it, vi } from "vitest";
import type { GitService } from "@notefig/git";
import { createPresence } from "./sync-presence";
import type { SyncClaim } from "./sync-machine";

const claim: SyncClaim = { path: "note.md", keys: ["k1"], agent: false };
const yielded: SyncClaim = { path: "note.md", keys: ["k2"], agent: false };

/** A presence over a branch whose tip is `tip` (tree `root`), with `wip`
 *  standing in for this device's work in progress. */
function presenceWith(wip: () => Promise<never>) {
  const git = {
    log: vi.fn(async () => [{ oid: "tip", commit: { tree: "root" } }]),
    treeWith: vi.fn(async () => "with-wip"),
    commit: vi.fn(async (_: { message: string; tree: string; parent: string[] }) => "beat"),
    pushRef: vi.fn(async () => {}),
  };
  const presence = createPresence({
    deviceId: "dev",
    author: { name: "Ada", email: "ada@example.com" },
    git: git as unknown as GitService,
    remote: { url: "https://example.com/notes.git" } as never,
    branch: "main",
    now: () => 0,
    state: () => ({ peers: [] }) as never,
    dispatch: () => {},
    claims: () => [claim],
    yielded: () => [yielded],
    wip,
  });
  return { presence, git };
}

describe("sync presence", () => {
  it("still sends its claims, over the tip's tree, when its work in progress can't be had", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { presence, git } = presenceWith(() => Promise.reject(new Error("the save failed")));
    await expect(presence.heartbeat()).resolves.toBeUndefined();
    expect(git.treeWith).not.toHaveBeenCalled();
    expect(git.commit).toHaveBeenCalledWith(expect.objectContaining({ tree: "root", parent: ["tip"] }));
    expect(JSON.parse(git.commit.mock.calls[0]![0].message)).toMatchObject({ claims: [claim], yielded: [yielded] });
    expect(git.pushRef).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ oid: "beat" }));
  });
});
