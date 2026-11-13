import { describe, expect, it, vi } from "vitest";
import { GitError, type GitService } from "@notefig/git";
import type { GitWorker } from "@/modules/git-worker";
import { createWorkspaceGitRemote } from "./git-remote";

const URL_ = "https://github.com/team/notes.git";
const SSH_URL = "git@github.com:team/notes.git";
const TARGET = { remote: "origin", url: URL_, branch: "main", remoteRef: "refs/heads/main", upstreamRenamed: false };
const REMOTE = { name: "origin", url: URL_, credential: "/ws" };

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

  it("takes HTTPS and SSH remotes, and passes on why there's no target", async () => {
    const local = setup({ remoteTarget: vi.fn(async () => ({ ...TARGET, url: "/srv/notes.git" })) });
    await expect(local.remote.urls()).rejects.toThrow(/HTTPS and SSH/);
    await expect(local.remote.push()).rejects.toThrow(/HTTPS and SSH/);

    const ssh = setup({ remoteTarget: vi.fn(async () => ({ ...TARGET, url: SSH_URL })) });
    await expect(ssh.remote.push()).resolves.toMatchObject({ pushed: true });
    await expect(ssh.remote.urls()).rejects.toThrow(/SSH keys/);

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

  it.each([
    ["AuthRequired", /ssh-add/],
    ["AuthFailed", /SSH key can.t write to github.com\/team\/notes\./],
    ["RepoNotFound", /SSH key can't see it/],
    ["HostUnverified", /ssh -T git@github.com in a terminal/],
    ["Network", /over SSH/],
    ["UnsupportedOperation", /ssh command/],
    ["NotFastForward", /Pull them first/],
  ] as const)("explains %s over SSH", async (code, message) => {
    const { remote } = setup({
      remoteTarget: vi.fn(async () => ({ ...TARGET, url: SSH_URL })),
      pushBranch: vi.fn(async () => { throw new GitError(code, "raw"); }),
    });
    await expect(remote.push()).rejects.toThrow(message);
  });

  it.each([
    ["git@[::1]:notes.git", "ssh -T git@::1 in a terminal"],
    ["[::1]:notes.git", "ssh -T ::1 in a terminal"],
    ["gh:team/notes.git", "ssh -T gh in a terminal"],
    ["ssh://git@host:2222/notes.git", "ssh -T ssh://git@host:2222 in a terminal"],
  ])("names a destination ssh can reach for %s", async (url, message) => {
    const { remote } = setup({
      remoteTarget: vi.fn(async () => ({ ...TARGET, url })),
      pushBranch: vi.fn(async () => { throw new GitError("HostUnverified", "raw"); }),
    });
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
    await used.remote.urls();
    used.remote.dispose();
    expect(used.gitWorker.dispose).toHaveBeenCalledWith("/ws/.git");
  });

  it("lists each repository the branch uses once, skipping one it can't", async () => {
    await expect(setup().remote.urls()).resolves.toEqual([URL_]);

    const upstream = "https://github.com/team/upstream.git";
    const fork = setup({ remoteTarget: vi.fn(async (direction) => ({ ...TARGET, url: direction === "pull" ? upstream : URL_ })) });
    await expect(fork.remote.urls()).resolves.toEqual([URL_, upstream]);

    const sshPush = setup({ remoteTarget: vi.fn(async (direction) => ({ ...TARGET, url: direction === "pull" ? upstream : SSH_URL })) });
    await expect(sshPush.remote.urls()).resolves.toEqual([upstream]);
  });

  it("serializes mutations and releases the lane after a failure", async () => {
    let finishPush!: (value: boolean) => void;
    const pushBranch = vi.fn(() => new Promise<boolean>((resolve) => { finishPush = resolve; }));
    const pullBranch = vi.fn(async () => 1);
    const { remote } = setup({ pushBranch, pullBranch });
    const push = remote.push();
    const pull = remote.pull();
    await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledOnce());
    expect(pullBranch).not.toHaveBeenCalled();
    finishPush(true);
    await expect(push).resolves.toMatchObject({ pushed: true });
    await expect(pull).resolves.toBe(1);

    pushBranch.mockRejectedValueOnce(new Error("failed"));
    await expect(remote.push()).rejects.toThrow("failed");
    await expect(remote.pull()).resolves.toBe(1);
  });
});
