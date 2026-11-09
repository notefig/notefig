import { describe, expect, it, vi } from "vitest";
import { GitError, type GitService } from "@notefig/git";
import type { GitWorker } from "@/modules/git-worker";
import { createWorkspaceGitRemote } from "./git-remote";

const URL_ = "https://github.com/team/notes.git";
const REF = "refs/heads/main";
const CLEAN = { staged: [], unstaged: [], untracked: [] };
const encode = (text: string) => new TextEncoder().encode(text);

function setup(overrides: Partial<GitService> = {}, config: Record<string, string> = { "remote.origin.url": URL_ }) {
  const git = {
    currentBranch: vi.fn(async () => "main"),
    getConfig: vi.fn(async (path: string) => config[path]),
    log: vi.fn(async () => [{ oid: "mine" }]),
    listRemoteRefs: vi.fn(async () => [{ ref: REF, oid: "theirs" }]),
    pushRef: vi.fn(async () => {}),
    fetchRefs: vi.fn(async () => [{ ref: REF, oid: "theirs" }]),
    mergeBase: vi.fn(async () => "mine"),
    changedFiles: vi.fn(async () => ["a.md"]),
    status: vi.fn(async () => CLEAN),
    merge: vi.fn(async () => ({})),
    readFile: vi.fn(async () => encode("new\n")),
    unstage: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GitService;
  const gitWorker = { create: vi.fn(() => git), dispose: vi.fn() } satisfies GitWorker;
  const documents = { write: vi.fn(async () => {}), hasUnsavedEdits: vi.fn(() => false) };
  const fs = { writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })), deleteFiles: vi.fn(async () => ({ succeeded: [], failed: [] })) };
  const files = { recordDiskChanges: vi.fn(async () => {}) };
  const remote = createWorkspaceGitRemote({ workspacePath: "/ws", fs: fs as never, gitWorker, documents: documents as never, files });
  return { remote, git, gitWorker, documents, fs, files };
}

describe("git remote: target", () => {
  it("does nothing, and boots nothing, until asked", () => {
    expect(setup().gitWorker.create).not.toHaveBeenCalled();
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
    ["no repository", { currentBranch: async () => { throw new Error("nope"); } }, {}, /isn't a git repository/],
  ])("says why it can't with %s", async (_name, git, config, problem) => {
    const found = await setup(git as Partial<GitService>, config as Record<string, string>).remote.target();
    expect(found).toEqual({ problem: expect.stringMatching(problem) });
  });
});

describe("git remote: push", () => {
  it("pushes the head over the tip it saw, never forced", async () => {
    const { remote, git } = setup();
    await expect(remote.push()).resolves.toEqual({ branch: "main", pushed: true });
    expect(git.pushRef).toHaveBeenCalledWith({ url: URL_ }, { ref: REF, oid: "mine", expect: "theirs" });
  });

  it("creates a branch the remote doesn't have, and skips one already there", async () => {
    const created = setup({ listRemoteRefs: vi.fn(async () => []) });
    await created.remote.push();
    expect(created.git.pushRef).toHaveBeenCalledWith({ url: URL_ }, { ref: REF, oid: "mine", expect: null });

    const same = setup({ listRemoteRefs: vi.fn(async () => [{ ref: REF, oid: "mine" }]) });
    await expect(same.remote.push()).resolves.toEqual({ branch: "main", pushed: false });
    expect(same.git.pushRef).not.toHaveBeenCalled();
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
    const { remote } = setup({ pushRef: vi.fn(async () => { throw new GitError(code, "raw"); }) });
    await expect(remote.push()).rejects.toThrow(message);
  });
});

describe("git remote: pull", () => {
  it("fast-forwards and writes through documents, so open editors follow", async () => {
    const { remote, git, documents, files } = setup();
    await expect(remote.pull()).resolves.toBe(1);
    expect(git.merge).toHaveBeenCalledWith({ ours: REF, theirs: "theirs", fastForwardOnly: true });
    expect(git.unstage).toHaveBeenCalledWith({ filepath: "a.md", ref: "theirs" });
    expect(documents.write).toHaveBeenCalledWith("/ws/a.md", "new\n");
    expect(files.recordDiskChanges).toHaveBeenCalledWith({ created: ["/ws/a.md"], deleted: [] });
  });

  it("deletes what the remote deleted, and writes binaries as bytes", async () => {
    const { remote, fs, documents } = setup({
      changedFiles: vi.fn(async () => ["gone.md", "image.png"]),
      readFile: vi.fn(async ({ filepath }: { filepath: string }) => (filepath === "gone.md" ? null : new Uint8Array([0, 1]))),
    } as never);
    await expect(remote.pull()).resolves.toBe(2);
    expect(fs.deleteFiles).toHaveBeenCalledWith(["/ws/gone.md"]);
    expect(fs.writeBinaryFiles).toHaveBeenCalledWith([{ path: "/ws/image.png", data: new Uint8Array([0, 1]) }]);
    expect(documents.write).not.toHaveBeenCalled();
  });

  it("has nothing to do when up to date or ahead", async () => {
    const same = setup({ fetchRefs: vi.fn(async () => [{ ref: REF, oid: "mine" }]) });
    await expect(same.remote.pull()).resolves.toBe(0);
    const ahead = setup({ mergeBase: vi.fn(async () => "theirs") });
    await expect(ahead.remote.pull()).resolves.toBe(0);
    expect(ahead.git.merge).not.toHaveBeenCalled();
  });

  it("refuses to merge a branch that has diverged", async () => {
    const { remote, git } = setup({ mergeBase: vi.fn(async () => "older") });
    await expect(remote.pull()).rejects.toThrow(/both moved/);
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("refuses before moving anything over saved local changes", async () => {
    const { remote, git, documents } = setup({
      status: vi.fn(async () => ({ ...CLEAN, unstaged: [{ path: "a.md", type: "modified" }] })),
    } as never);
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
    expect(documents.write).not.toHaveBeenCalled();
  });

  it("refuses before moving anything over unsaved editor edits", async () => {
    const { remote, git, documents } = setup();
    documents.hasUnsavedEdits.mockReturnValue(true);
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
  });
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
