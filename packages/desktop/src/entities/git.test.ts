import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { GitError, type GitService } from "@notefig/git";
import { FsError } from "@/adapters/platform-adapter.interface";
import { createCore, defineModule } from "@notefig/core";
import { workspaceKey } from "@/utils/path";
import {
  createWorkspaceGit,
  fetchGitRows,
  gitModule,
  type GitCheckpointRow,
  type GitRepoRow,
} from "./git";

// The workspace's history repo, as git receives it from core: no module
// mocks — the instance is built from what a test hands it.
const statusMock = vi.fn();
const logMock = vi.fn();
const addAllAndCommitMock = vi.fn();
const service = {
  status: statusMock,
  log: logMock,
  addAllAndCommit: addAllAndCommitMock,
} as unknown as GitService;
const history = { service: () => service, ready: async () => service };

function workspaceGit() {
  return createWorkspaceGit({
    workspacePath: WS,
    queryClient: new QueryClient(),
    history,
  });
}

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

    const rows = await fetchGitRows(service, WS);

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
    statusMock.mockRejectedValue(new GitError("RepoNotFound", "no repo here"));

    const rows = await fetchGitRows(service, WS);

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
    logMock.mockRejectedValue(new GitError("LockUnavailable", "busy"));

    const rows = await fetchGitRows(service, WS);

    const repo = repoRow(rows);
    expect(repo.statusError).toEqual({ code: "Unknown", message: "exploded" });
    expect(repo.logError).toEqual({ code: "LockUnavailable", message: "busy" });
  });

  it("workspace-access errors rethrow for the error boundary", async () => {
    statusMock.mockRejectedValue(
      new FsError("permission_denied", WS, "denied"),
    );

    await expect(fetchGitRows(service, WS)).rejects.toBeInstanceOf(FsError);
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
    const git = workspaceGit();
    await git.collection.preload();
    const oid = await git.saveCheckpoint("did things");

    expect(oid).toBe("feedbeef00");
    expect(addAllAndCommitMock).toHaveBeenCalledWith({
      message: "did things",
      author: { name: "Notefig", email: "git@notefig.com" },
    });

    const rows = git.collection.toArray as GitCheckpointRow[];
    const committed = rows.find((r) => r.id === "cp:feedbeef00");
    expect(committed).toMatchObject({
      hash: "feedbee",
      message: "did things",
    });
  });

  it("rejects when the commit fails, leaving no checkpoint row behind", async () => {
    addAllAndCommitMock.mockRejectedValue(
      new GitError("LockUnavailable", "busy"),
    );

    const git = workspaceGit();
    await expect(git.saveCheckpoint("nope")).rejects.toMatchObject({
      message: expect.stringContaining("busy"),
    });

    const collection = git.collection;
    expect(
      collection.toArray.filter(
        (r) => r.kind === "checkpoint" && r.message === "nope",
      ),
    ).toHaveLength(0);
  });

  it("returns null when there is nothing to commit", async () => {
    addAllAndCommitMock.mockResolvedValue(null);

    await expect(workspaceGit().saveCheckpoint("empty")).resolves.toBeNull();
  });
});

describe("git instance lifetime", () => {
  it("dispose drops the cached rows, so a reopen fetches afresh", async () => {
    const queryClient = new QueryClient();
    const git = createWorkspaceGit({ workspacePath: WS, queryClient, history });
    await git.collection.preload();
    expect(queryClient.getQueryData(["git", WS])).toBeDefined();

    git.dispose();

    expect(queryClient.getQueryData(["git", WS])).toBeUndefined();
  });
});

describe("gitModule", () => {
  it("refetches when its own workspace is announced stale, until it closes", async () => {
    const historyModule = defineModule({
      name: "history",
      workspace: { create: () => history as never },
    });
    const core = createCore({
      services: { queryClient: new QueryClient() } as never,
      modules: [historyModule, gitModule],
      workspaceKey,
    });
    await core.workspace(WS).open();
    await core.workspace(WS).git.collection.preload();
    statusMock.mockClear();

    core.hooks.emit("git:stale", { workspacePath: "/somewhere-else" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusMock).not.toHaveBeenCalled();

    core.hooks.emit("git:stale", { workspacePath: WS });
    await vi.waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));

    await core.workspace(WS).close();
    core.hooks.emit("git:stale", { workspacePath: WS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusMock).toHaveBeenCalledTimes(1);
  });
});
