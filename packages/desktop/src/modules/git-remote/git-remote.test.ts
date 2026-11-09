import { describe, expect, it, vi } from "vitest";
import { GitError, type GitService } from "@notefig/git";
import type { GitWorker } from "@/modules/git-worker";
import { createWorkspaceGitRemote } from "./git-remote";

const URL_ = "https://github.com/team/notes.git";
const REF = "refs/heads/main";
const REMOTE = { url: URL_, credential: "/ws" };
const encode = (text: string) => new TextEncoder().encode(text);
const changed = (...paths: string[]) => paths.map((path) => ({ path, modeChanged: false }));

function setup(overrides: Partial<GitService> = {}, config: Record<string, string> = { "remote.origin.url": URL_ }) {
  const git = {
    currentBranch: vi.fn(async () => "main"),
    getConfig: vi.fn(async (path: string) => config[path]),
    log: vi.fn(async () => [{ oid: "mine" }]),
    listRemoteRefs: vi.fn(async () => [{ ref: REF, oid: "theirs" }]),
    pushRef: vi.fn(async () => {}),
    fetchRefs: vi.fn(async () => [{ ref: REF, oid: "theirs" }]),
    mergeBase: vi.fn(async () => "mine"),
    changedFiles: vi.fn(async () => changed("a.md")),
    merge: vi.fn(async () => ({})),
    status: vi.fn(async () => ({ staged: [], unstaged: [], untracked: [] })),
    readFile: vi.fn(async ({ ref }: { ref: string }) => encode(ref === "mine" ? "old\n" : "new\n")),
    unstage: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GitService;
  const gitWorker = { create: vi.fn(() => git), dispose: vi.fn() } satisfies GitWorker;
  // What's on disk: the last commit's text until something writes.
  const disk = new Map<string, Uint8Array>();
  const documents = {
    write: vi.fn(async (path: string, text: string) => void disk.set(path, encode(text))),
    hasUnsavedEdits: vi.fn((_path: string) => false),
  };
  const ok = { succeeded: [], failed: [] };
  const fs = {
    readBinaryFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths.map((path) => ({ path, data: disk.get(path) ?? encode("old\n") })),
      failed: [] as unknown[],
    })),
    writeBinaryFiles: vi.fn(async () => ok),
    deleteFiles: vi.fn(async () => ok),
  };
  const files = { recordDiskChanges: vi.fn(async () => {}) };
  const remote = createWorkspaceGitRemote({ workspacePath: "/ws", fs: fs as never, gitWorker, documents: documents as never, files });
  return { remote, git, gitWorker, documents, fs, files, disk };
}

describe("git remote: target", () => {
  it("does nothing, and boots nothing, until asked", () => {
    expect(setup().gitWorker.create).not.toHaveBeenCalled();
  });

  it("follows the branch's own remote, falling back to origin", async () => {
    const { remote } = setup({}, { "branch.main.remote": "fork", "remote.fork.url": "https://h/fork.git" });
    await expect(remote.target()).resolves.toEqual({ url: "https://h/fork.git", branch: "main", remoteRef: REF, upstreamRenamed: false });
    await expect(setup().remote.target()).resolves.toEqual({ url: URL_, branch: "main", remoteRef: REF, upstreamRenamed: false });
  });

  it("pushes to the push remote and push URL, and pulls from the fetch one", async () => {
    const config = {
      "branch.main.remote": "upstream",
      "branch.main.pushRemote": "fork",
      "remote.upstream.url": "https://h/up.git",
      "remote.fork.url": "https://h/fork.git",
      "remote.fork.pushurl": "https://h/fork-push.git",
    };
    const { remote } = setup({}, config);
    await expect(remote.target("push")).resolves.toMatchObject({ url: "https://h/fork-push.git" });
    await expect(remote.target("pull")).resolves.toMatchObject({ url: "https://h/up.git" });

    const byDefault = setup({}, { "remote.pushDefault": "fork", "remote.fork.url": "https://h/fork.git", "remote.origin.url": URL_ });
    await expect(byDefault.remote.target("push")).resolves.toMatchObject({ url: "https://h/fork.git" });
    await expect(byDefault.remote.target("pull")).resolves.toMatchObject({ url: URL_ });
  });

  it("pulls the upstream's name, and won't push to a differently named one", async () => {
    const config = { "branch.main.remote": "origin", "branch.main.merge": "refs/heads/trunk", "remote.origin.url": URL_ };
    const { remote } = setup({}, config);
    await expect(remote.target("pull")).resolves.toMatchObject({ remoteRef: "refs/heads/trunk" });
    // Still a target, so its credential can be set; only the push refuses.
    await expect(remote.target("push")).resolves.toMatchObject({ remoteRef: REF, upstreamRenamed: true });
    await expect(remote.push()).rejects.toThrow(/another name/);
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
    expect(git.pushRef).toHaveBeenCalledWith(REMOTE, { ref: REF, oid: "mine", expect: "theirs" });
  });

  it("creates a branch the remote doesn't have, and skips one already there", async () => {
    const created = setup({ listRemoteRefs: vi.fn(async () => []) });
    await created.remote.push();
    expect(created.git.pushRef).toHaveBeenCalledWith(REMOTE, { ref: REF, oid: "mine", expect: null });

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
  it("writes through documents so open editors follow, then moves the branch", async () => {
    const { remote, git, documents, files } = setup();
    await expect(remote.pull()).resolves.toBe(1);
    expect(documents.write).toHaveBeenCalledWith("/ws/a.md", "new\n");
    expect(vi.mocked(documents.write).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(git.merge).mock.invocationCallOrder[0]);
    expect(git.merge).toHaveBeenCalledWith({ ours: REF, theirs: "theirs", fastForwardOnly: true });
    expect(git.unstage).toHaveBeenCalledWith({ filepath: "a.md", ref: "theirs" });
    expect(files.recordDiskChanges).toHaveBeenCalledWith({ created: ["/ws/a.md"], deleted: [] });
  });

  it("fetches the upstream, into the local branch", async () => {
    const config = { "branch.main.remote": "origin", "branch.main.merge": "refs/heads/trunk", "remote.origin.url": URL_ };
    const { remote, git } = setup({ fetchRefs: vi.fn(async () => [{ ref: "refs/heads/trunk", oid: "theirs" }]) }, config);
    await remote.pull();
    expect(git.fetchRefs).toHaveBeenCalledWith(REMOTE, ["refs/heads/trunk"]);
    expect(git.merge).toHaveBeenCalledWith({ ours: REF, theirs: "theirs", fastForwardOnly: true });
  });

  it("deletes what the remote deleted, and writes binaries as bytes", async () => {
    const { remote, fs, documents } = setup({
      changedFiles: vi.fn(async () => changed("gone.md", "image.png")),
      readFile: vi.fn(async ({ ref, filepath }: { ref: string; filepath: string }) =>
        ref === "mine" ? encode("old\n") : filepath === "gone.md" ? null : new Uint8Array([0, 1]),
      ),
    } as never);
    await expect(remote.pull()).resolves.toBe(2);
    expect(fs.deleteFiles).toHaveBeenCalledWith(["/ws/gone.md"]);
    expect(fs.writeBinaryFiles).toHaveBeenCalledWith([{ path: "/ws/image.png", data: new Uint8Array([0, 1]) }]);
    expect(documents.write).not.toHaveBeenCalled();
  });

  it("keeps a byte-order mark", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const { remote, documents } = setup({
      readFile: vi.fn(async ({ ref }: { ref: string }) => (ref === "mine" ? encode("old\n") : bom)),
    } as never);
    await remote.pull();
    expect(documents.write).toHaveBeenCalledWith("/ws/a.md", "﻿hi");
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

  it("refuses over a file that isn't what the last commit has", async () => {
    const { remote, git, documents, fs } = setup();
    fs.readBinaryFiles.mockResolvedValue({ succeeded: [{ path: "/ws/a.md", data: encode("edited\n") }], failed: [] });
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
    expect(documents.write).not.toHaveBeenCalled();
  });

  it("refuses over unsaved editor edits", async () => {
    const { remote, git, documents } = setup();
    documents.hasUnsavedEdits.mockReturnValue(true);
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("refuses over a local file (ignored or not) where the remote adds one", async () => {
    const { remote, git } = setup({
      readFile: vi.fn(async ({ ref }: { ref: string }) => (ref === "mine" ? null : encode("new\n"))),
    } as never);
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("stops if typing lands after the check, and puts back what it wrote", async () => {
    const { remote, git, documents } = setup({ changedFiles: vi.fn(async () => changed("a.md", "b.md")) });
    let checks = 0;
    documents.hasUnsavedEdits.mockImplementation((path) => path === "/ws/b.md" && checks++ > 0);
    await expect(remote.pull()).rejects.toThrow(/Local changes in b.md/);
    expect(documents.write).toHaveBeenNthCalledWith(1, "/ws/a.md", "new\n");
    expect(documents.write).toHaveBeenNthCalledWith(2, "/ws/a.md", "old\n");
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("leaves a file edited after the pull wrote it, and says so", async () => {
    const { remote, git, documents, fs, disk } = setup({
      changedFiles: vi.fn(async () => changed("a.md", "b.png")),
      readFile: vi.fn(async ({ ref, filepath }: { ref: string; filepath: string }) =>
        ref === "mine" ? encode("old\n") : filepath === "b.png" ? new Uint8Array([0]) : encode("new\n"),
      ),
    } as never);
    fs.writeBinaryFiles.mockImplementation(async () => {
      disk.set("/ws/a.md", encode("typed since\n"));
      return { succeeded: [], failed: [{ message: "disk full" }] } as never;
    });
    await expect(remote.pull()).rejects.toThrow(/disk full.*Kept newer edits in a.md/);
    expect(documents.write).toHaveBeenCalledTimes(1);
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("refuses over a staged edit, even if the file matches the commit", async () => {
    const { remote, git, documents } = setup({
      status: vi.fn(async () => ({ staged: [{ path: "a.md", type: "modified" }], unstaged: [], untracked: [] })),
    } as never);
    await expect(remote.pull()).rejects.toThrow(/Local changes in a.md/);
    expect(git.merge).not.toHaveBeenCalled();
    expect(documents.write).not.toHaveBeenCalled();
  });

  it("reports a failed write, puts files back and leaves the branch", async () => {
    const { remote, git, documents, fs } = setup({
      changedFiles: vi.fn(async () => changed("a.md", "b.png")),
      readFile: vi.fn(async ({ ref, filepath }: { ref: string; filepath: string }) =>
        ref === "mine" ? encode("old\n") : filepath === "b.png" ? new Uint8Array([0]) : encode("new\n"),
      ),
    } as never);
    fs.writeBinaryFiles.mockResolvedValue({ succeeded: [], failed: [{ message: "disk full" }] } as never);
    await expect(remote.pull()).rejects.toThrow(/Couldn't update b.png: disk full/);
    expect(documents.write).toHaveBeenLastCalledWith("/ws/a.md", "old\n");
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("refuses file-for-folder swaps and permission changes before touching anything", async () => {
    const swap = setup({ readFile: vi.fn(async () => { throw new Error("not a blob"); }) } as never);
    await expect(swap.remote.pull()).rejects.toThrow(/between a file and a folder/);
    expect(swap.documents.write).not.toHaveBeenCalled();

    const mode = setup({ changedFiles: vi.fn(async () => [{ path: "run.sh", modeChanged: true }]) });
    await expect(mode.remote.pull()).rejects.toThrow(/permissions changed in run.sh/);
    expect(mode.git.merge).not.toHaveBeenCalled();
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
