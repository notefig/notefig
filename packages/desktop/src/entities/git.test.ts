import { beforeEach, describe, expect, it, vi } from "vitest";
import { FsError } from "@/adapters/platform-adapter.interface";

const { statusMock, logMock, addAllAndCommitMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  logMock: vi.fn(),
  addAllAndCommitMock: vi.fn(),
}));

vi.mock("@metrists/git", () => {
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

vi.mock("@/adapters", () => ({
  platformAdapter: {
    getGitStorageHost: vi.fn(() => ({})),
  },
}));

// The mocked GitError class, for constructing typed failures in tests.
const { GitError: MockGitError } = (await import(
  "@metrists/git"
)) as unknown as {
  GitError: new (code: string, message: string) => Error;
};

import {
  fetchGitRows,
  getOrCreateGitCollection,
  saveCheckpoint,
  type GitCheckpointRow,
  type GitRepoRow,
} from "./git";

const WS = "/tmp/ws-git-entity-test";

function repoRow(rows: Awaited<ReturnType<typeof fetchGitRows>>): GitRepoRow {
  const row = rows.find((r): r is GitRepoRow => r.kind === "repo");
  if (!row) throw new Error("no repo row");
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusMock.mockResolvedValue({
    repoPath: WS,
    currentBranch: "main",
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    ahead: 0,
  });
  logMock.mockResolvedValue([]);
});

describe("fetchGitRows", () => {
  it("flattens status + log into repo/file/checkpoint rows", async () => {
    statusMock.mockResolvedValue({
      repoPath: WS,
      currentBranch: "main",
      staged: [{ path: "a.md", type: "modify" }],
      unstaged: [{ path: "a.md", type: "modify" }],
      untracked: ["b.md"],
      conflicts: [],
      ahead: 2,
    });
    logMock.mockResolvedValue([
      {
        oid: "abc1234def",
        commit: {
          message: "First line\nBody",
          committer: { timestamp: 1_000 },
        },
      },
    ]);

    const rows = await fetchGitRows(WS);

    const repo = repoRow(rows);
    expect(repo.initialized).toBe(true);
    expect(repo.branch).toBe("main");
    expect(repo.ahead).toBe(2);
    expect(repo.statusError).toBeUndefined();

    const fileRows = rows.filter((r) => r.kind === "file");
    expect(fileRows).toHaveLength(2);
    const a = fileRows.find((r) => r.path === `${WS}/a.md`);
    expect(a).toMatchObject({ staged: true, unstaged: true, untracked: false });
    const b = fileRows.find((r) => r.path === `${WS}/b.md`);
    expect(b).toMatchObject({ untracked: true, staged: false });

    const checkpoints = rows.filter(
      (r): r is GitCheckpointRow => r.kind === "checkpoint",
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      id: "cp:abc1234def",
      hash: "abc1234",
      message: "First line",
      timestamp: 1_000_000,
    });
  });

  it("RepoNotFound becomes uninitialized repo row and skips log", async () => {
    statusMock.mockRejectedValue(
      new MockGitError("RepoNotFound", "no repo here"),
    );

    const rows = await fetchGitRows(WS);

    const repo = repoRow(rows);
    expect(repo.initialized).toBe(false);
    expect(repo.statusError).toEqual({
      code: "RepoNotFound",
      message: "no repo here",
    });
    expect(logMock).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.kind === "checkpoint")).toHaveLength(0);
  });

  it("non-GitError failures land as Unknown errors-as-data", async () => {
    statusMock.mockRejectedValue(new Error("exploded"));
    logMock.mockRejectedValue(new MockGitError("LockUnavailable", "busy"));

    const rows = await fetchGitRows(WS);

    const repo = repoRow(rows);
    expect(repo.statusError).toEqual({ code: "Unknown", message: "exploded" });
    expect(repo.logError).toEqual({ code: "LockUnavailable", message: "busy" });
  });

  it("workspace-access errors rethrow for the error boundary", async () => {
    statusMock.mockRejectedValue(
      new FsError("permission_denied", WS, "denied"),
    );

    await expect(fetchGitRows(WS)).rejects.toBeInstanceOf(FsError);
  });
});

describe("saveCheckpoint (optimistic insert)", () => {
  it("replaces the pending row with the real commit on success", async () => {
    addAllAndCommitMock.mockImplementation(async () => {
      // After the commit, the real git log would include it — the trailing
      // refetch must not wipe the direct-written row.
      logMock.mockResolvedValue([
        {
          oid: "feedbeef00",
          commit: {
            message: "did things",
            committer: { timestamp: 2_000 },
          },
        },
      ]);
      return "feedbeef00";
    });

    // Start the collection's sync (in the app a live-query subscription
    // does this) so the handler's direct writes apply.
    await getOrCreateGitCollection(WS).preload();
    await saveCheckpoint(WS, "did things");

    const collection = getOrCreateGitCollection(WS);
    const rows = collection.toArray as GitCheckpointRow[];
    const pending = rows.filter((r) => r.pending);
    expect(pending).toHaveLength(0);
    const committed = rows.find((r) => r.id === "cp:feedbeef00");
    expect(committed).toMatchObject({
      hash: "feedbee",
      message: "did things",
    });
  });

  it("rolls the pending row back when the commit fails", async () => {
    addAllAndCommitMock.mockRejectedValue(
      new MockGitError("LockUnavailable", "busy"),
    );

    await expect(saveCheckpoint(WS, "nope")).rejects.toMatchObject({
      message: expect.stringContaining("busy"),
    });

    const collection = getOrCreateGitCollection(WS);
    expect(
      collection.toArray.filter(
        (r) => r.kind === "checkpoint" && r.message === "nope",
      ),
    ).toHaveLength(0);
  });

  it("drops the pending row when there is nothing to commit (null oid)", async () => {
    addAllAndCommitMock.mockResolvedValue(null);

    await saveCheckpoint(WS, "empty");

    const collection = getOrCreateGitCollection(WS);
    expect(
      collection.toArray.filter(
        (r) => r.kind === "checkpoint" && r.message === "empty",
      ),
    ).toHaveLength(0);
  });
});
