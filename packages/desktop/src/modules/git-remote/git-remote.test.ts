import { describe, expect, it, vi } from "vitest";
import { GitError, type GitService } from "@notefig/git";
import type { GitWorker } from "@/modules/git-worker";
import { createWorkspaceGitRemote } from "./git-remote";

const URL_ = "https://github.com/team/notes.git";
const TARGET = { url: URL_, branch: "main", remoteRef: "refs/heads/main", upstreamRenamed: false };
const REMOTE = { url: URL_, credential: "/ws" };

function setup(overrides: Partial<GitService> = {}) {
  const git = {
    remoteTarget: vi.fn(async () => TARGET),
    pushBranch: vi.fn(async () => true),
    pullBranch: vi.fn(async () => 2),
    ...overrides,
  } as unknown as GitService;
  const gitWorker = { create: vi.fn(() => git), dispose: vi.fn() } satisfies GitWorker;
  return { remote: createWorkspaceGitRemote({ workspacePath: "/ws", gitWorker }), git, gitWorker };
}

describe("git remote", () => {
  it("boots nothing until asked", () => {
    expect(setup().gitWorker.create).not.toHaveBeenCalled();
  });

  it("pushes and pulls with the workspace as the credential's repository", async () => {
    const { remote, git } = setup();
    await expect(remote.push()).resolves.toEqual({ branch: "main", pushed: true });
    expect(git.pushBranch).toHaveBeenCalledWith(REMOTE, TARGET);
    await expect(remote.pull()).resolves.toBe(2);
    expect(git.pullBranch).toHaveBeenCalledWith(REMOTE, TARGET);
    expect(git.remoteTarget).toHaveBeenLastCalledWith("pull");
  });

  it("only speaks HTTPS for now, and passes on why there's no target", async () => {
    const ssh = setup({ remoteTarget: vi.fn(async () => ({ ...TARGET, url: "git@github.com:t/n.git" })) });
    await expect(ssh.remote.target()).resolves.toEqual({ problem: expect.stringMatching(/HTTPS/) });
    await expect(ssh.remote.push()).rejects.toThrow(/HTTPS/);

    const none = setup({ remoteTarget: vi.fn(async () => ({ problem: "No remote." })) });
    await expect(none.remote.pull()).rejects.toThrow("No remote.");
  });

  it.each([
    ["AuthRequired", /Use a Token/],
    ["AuthFailed", /can't access/],
    ["RepoNotFound", /wasn't found/],
    ["Network", /Couldn't reach github.com/],
    ["Throttled", /rate limiting/],
    ["NotFastForward", /Pull them first/],
    ["RefConflict", /Pull them first/],
  ] as const)("explains %s", async (code, message) => {
    const { remote } = setup({ pushBranch: vi.fn(async () => { throw new GitError(code, "raw"); }) });
    await expect(remote.push()).rejects.toThrow(message);
  });

  it("passes a refused pull's own message through", async () => {
    const { remote } = setup({ pullBranch: vi.fn(async () => { throw new GitError("PullRefused", "Local changes in a.md."); }) });
    await expect(remote.pull()).rejects.toThrow("Local changes in a.md.");
  });

  it("releases the repo's worker state only if it used it", async () => {
    const idle = setup();
    idle.remote.dispose();
    expect(idle.gitWorker.dispose).not.toHaveBeenCalled();

    const used = setup();
    await used.remote.target();
    used.remote.dispose();
    expect(used.gitWorker.dispose).toHaveBeenCalledWith("/ws/.git");
  });
});
