import { beforeEach, describe, expect, it, vi } from "vitest";
import { FsError } from "@/adapters/platform-adapter.interface";

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

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: {},
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/adapters/git-storage-host", () => ({
  createGitStorageHost: vi.fn(() => ({})),
}));

// The mocked GitError class, for constructing typed failures in tests.
const { GitError: MockGitError } =
  (await import("@notefig/git")) as unknown as {
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

describe("saveCheckpoint (plain action + refetch)", () => {
  it("commits and the refetched rows include the new checkpoint", async () => {
    addAllAndCommitMock.mockImplementation(async () => {
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
    // does this) so the post-commit refetch lands in the synced store.
    await getOrCreateGitCollection(WS).preload();
    const oid = await saveCheckpoint(WS, "did things");

    expect(oid).toBe("feedbeef00");
    expect(addAllAndCommitMock).toHaveBeenCalledWith({
      repoPath: WS,
      message: "did things",
      author: { name: "Notefig", email: "git@notefig.com" },
    });

    const rows = getOrCreateGitCollection(WS).toArray as GitCheckpointRow[];
    const committed = rows.find((r) => r.id === "cp:feedbeef00");
    expect(committed).toMatchObject({
      hash: "feedbee",
      message: "did things",
    });
  });

  it("rejects when the commit fails, leaving no checkpoint row behind", async () => {
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

  it("returns null when there is nothing to commit", async () => {
    addAllAndCommitMock.mockResolvedValue(null);

    await expect(saveCheckpoint(WS, "empty")).resolves.toBeNull();
  });
});
