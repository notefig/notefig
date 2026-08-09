import { beforeEach, describe, expect, it, vi } from "vitest";

const { statusMock, logMock, addAllAndCommitMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  logMock: vi.fn(),
  addAllAndCommitMock: vi.fn(),
}));

vi.mock("@notefig/git", () => {
  class MockGitError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "GitError";
    }
  }
  return {
    IsomorphicGitService: vi.fn(() => ({
      status: statusMock,
      log: logMock,
      addAllAndCommit: addAllAndCommitMock,
    })),
    GitError: MockGitError,
  };
});

vi.mock("@/adapters", () => ({ platformAdapter: { fs: {} } }));
vi.mock("@/adapters/git-storage-host", () => ({
  createGitStorageHost: vi.fn(() => ({})),
}));

import { createLiveQueryCollection, eq } from "@tanstack/react-db";
import { getOrCreateGitCollection, invalidateGit, saveCheckpoint } from "./git";

const WS = "/tmp/ws-git-save-race-test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OLD_STATUS = {
  repoPath: WS,
  currentBranch: "main",
  staged: [{ path: "a.md", type: "modify" }],
  unstaged: [],
  untracked: [],
  conflicts: [],
  ahead: 0,
};
const OLD_LOG = [
  {
    oid: "8ec4833aa",
    commit: { message: "Commit", committer: { timestamp: 1_700 } },
  },
];

/**
 * Regression test for the stuck "pending" checkpoint row: a derived live
 * query (what useGitCheckpoints renders) must never retain a pending entry
 * after a save completes — even when a watcher-driven invalidation races
 * the commit. An optimistic collection insert with a synthetic key that
 * sync never confirms strands its ghost in derived live queries (observed
 * on @tanstack/db 0.6.1), which is why saveCheckpoint is a plain action and
 * the pending entry is render-level state in checkpoint-panel.
 *
 * The assertions below describe the correct end state, not the bug, so they
 * hold under either design — which makes this the gate for MET-125, where
 * @tanstack/db 0.6.7's server-generated-key fix is evaluated against
 * reintroducing optimistic handlers.
 */
describe("saveCheckpoint vs derived live queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusMock.mockResolvedValue(OLD_STATUS);
    logMock.mockResolvedValue(OLD_LOG);
  });

  it("leaves no pending ghost after a save with a racing invalidation", async () => {
    const collection = getOrCreateGitCollection(WS);
    const checkpoints = createLiveQueryCollection((q) =>
      q
        .from({ git: collection })
        .where(({ git }) => eq(git.kind, "checkpoint")),
    );
    const subscription = checkpoints.subscribeChanges(() => {});
    await checkpoints.stateWhenReady();

    addAllAndCommitMock.mockImplementation(async () => {
      // A watcher-driven invalidation lands mid-commit, while git still
      // reports pre-commit state.
      invalidateGit(WS);
      await sleep(30);
      logMock.mockResolvedValue([
        {
          oid: "025f78bbb",
          commit: { message: "Commit", committer: { timestamp: 1_800 } },
        },
        ...OLD_LOG,
      ]);
      statusMock.mockResolvedValue({ ...OLD_STATUS, staged: [] });
      return "025f78bbb";
    });

    const oid = await saveCheckpoint(WS, undefined);
    expect(oid).toBe("025f78bbb");

    // Let any trailing fetches settle, then assert the derived rows.
    await sleep(100);
    const ids = [...checkpoints.toArray].map((r) => r.id).sort();
    expect(ids).toEqual(["cp:025f78bbb", "cp:8ec4833aa"]);

    subscription.unsubscribe();
  });
});
