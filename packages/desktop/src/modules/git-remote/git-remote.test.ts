import { describe, expect, it, vi } from "vitest";
import { GitError, type GitService } from "@notefig/git";
import type { GitWorker } from "@/modules/git-worker";
import { createWorkspaceGitRemote } from "./git-remote";

const URL_ = "https://github.com/team/notes.git";
const REF = "refs/heads/main";

function setup(overrides: Partial<GitService> = {}, config: Record<string, string> = { "remote.origin.url": URL_ }) {
  const git = {
    currentBranch: vi.fn(async () => "main"),
    getConfig: vi.fn(async (path: string) => config[path]),
    log: vi.fn(async () => [{ oid: "mine" }]),
    listRemoteRefs: vi.fn(async () => [{ ref: REF, oid: "theirs" }]),
    pushRef: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GitService;
  const gitWorker = { create: vi.fn(() => git), dispose: vi.fn() } satisfies GitWorker;
  const exists = vi.fn(async () => [{ path: "/ws/.git", exists: true, type: "directory" }]);
  const remote = createWorkspaceGitRemote({ workspacePath: "/ws", fs: { exists } as never, gitWorker, supported: true });
  return { remote, git, gitWorker, exists };
}

describe("git remote", () => {
  it("checks availability with one exists call, without booting the worker", async () => {
    const { remote, gitWorker } = setup();
    await expect(remote.available()).resolves.toBe(true);
    expect(gitWorker.create).not.toHaveBeenCalled();
  });

  it("isn't available on a platform without remotes", async () => {
    const { exists, gitWorker } = setup();
    const remote = createWorkspaceGitRemote({ workspacePath: "/ws", fs: { exists } as never, gitWorker, supported: false });
    await expect(remote.available()).resolves.toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it("follows the branch's own remote, falling back to origin", async () => {
    const { remote } = setup({}, { "branch.main.remote": "fork", "remote.fork.url": "https://h/fork.git" });
    await expect(remote.target()).resolves.toEqual({ url: "https://h/fork.git", branch: "main" });
    await expect(setup().remote.target()).resolves.toEqual({ url: URL_, branch: "main" });
  });

  it.each([
    ["a detached HEAD", { currentBranch: async () => null }, { "remote.origin.url": URL_ }, /Check out a branch/],
    ["no remote", {}, {}, /no remote/],
    ["an SSH remote", {}, { "remote.origin.url": "git@github.com:t/n.git" }, /HTTPS/],
  ])("says why it can't push with %s", async (_name, git, config, problem) => {
    const found = await setup(git as Partial<GitService>, config as Record<string, string>).remote.target();
    expect(found).toEqual({ problem: expect.stringMatching(problem) });
  });

  it("pushes the head over the tip it saw, never forced", async () => {
    const { remote, git } = setup();
    await expect(remote.push()).resolves.toBe("pushed");
    expect(git.pushRef).toHaveBeenCalledWith({ url: URL_ }, { ref: REF, oid: "mine", expect: "theirs" });
  });

  it("creates a branch the remote doesn't have, and skips one already there", async () => {
    const created = setup({ listRemoteRefs: vi.fn(async () => []) });
    await created.remote.push();
    expect(created.git.pushRef).toHaveBeenCalledWith({ url: URL_ }, { ref: REF, oid: "mine", expect: null });

    const same = setup({ listRemoteRefs: vi.fn(async () => [{ ref: REF, oid: "mine" }]) });
    await expect(same.remote.push()).resolves.toBe("up-to-date");
    expect(same.git.pushRef).not.toHaveBeenCalled();
  });

  it.each([
    ["AuthRequired", /Paste a token/],
    ["AuthFailed", /can't push/],
    ["RepoNotFound", /wasn't found/],
    ["Network", /Couldn't reach github.com/],
    ["Throttled", /rate limiting/],
    ["NotFastForward", /Pull them first/],
    ["RefConflict", /Pull them first/],
  ] as const)("explains %s", async (code, message) => {
    const { remote } = setup({ pushRef: vi.fn(async () => { throw new GitError(code, "raw"); }) });
    await expect(remote.push()).rejects.toThrow(message);
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
