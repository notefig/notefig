import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IsomorphicGitService } from "./isomorphicGitService";
import {
  NodeGitStorageHost,
  commitViaGit,
  hasSystemGit,
  runGit,
  stubCompressionStreams,
} from "./realGit.test-helpers";

const describeRealGit = hasSystemGit ? describe : describe.skip;

describeRealGit("[real-git] IsomorphicGitService interoperability", () => {
  let repoDir: string;
  let service: IsomorphicGitService;
  let restoreCompressionStreams: () => void;

  beforeAll(() => {
    restoreCompressionStreams = stubCompressionStreams();
  });

  afterAll(() => {
    restoreCompressionStreams();
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "metrists-git-real-"));
    service = new IsomorphicGitService(new NodeGitStorageHost(repoDir));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("init produces a repository readable by system git", async () => {
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const isWorkTree = await runGit(repoDir, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    const branch = await runGit(repoDir, ["branch", "--show-current"]);

    expect(isWorkTree).toBe("true");
    expect(branch).toBe("main");
  });

  it("add and commit through service is visible in system git", async () => {
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await writeFile(join(repoDir, "note.md"), "hello\n", "utf8");

    await service.add({ repoPath: repoDir, filepath: "note.md" });
    const oid = await service.commit({
      repoPath: repoDir,
      message: "Add note",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    const head = await runGit(repoDir, ["rev-parse", "HEAD"]);
    const fileAtHead = await runGit(repoDir, ["show", "HEAD:note.md"]);
    const status = await runGit(repoDir, ["status", "--porcelain"]);

    expect(head).toBe(oid);
    expect(fileAtHead).toBe("hello");
    expect(status).toBe("");
  });

  it("addAllAndCommit handles modify/add/delete and leaves clean status", async () => {
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await writeFile(join(repoDir, "keep.md"), "keep\n", "utf8");
    await writeFile(join(repoDir, "delete.md"), "delete\n", "utf8");

    await service.add({
      repoPath: repoDir,
      filepath: ["keep.md", "delete.md"],
    });
    await service.commit({
      repoPath: repoDir,
      message: "baseline",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await writeFile(join(repoDir, "keep.md"), "keep updated\n", "utf8");
    await rm(join(repoDir, "delete.md"));
    await writeFile(join(repoDir, "new.md"), "new\n", "utf8");

    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "checkpoint",
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    const status = await runGit(repoDir, ["status", "--porcelain"]);
    const show = await runGit(repoDir, [
      "show",
      "--name-status",
      "--format=",
      "HEAD",
    ]);

    expect(oid).toHaveLength(40);
    expect(status).toBe("");
    expect(show).toContain("M\tkeep.md");
    expect(show).toContain("D\tdelete.md");
    expect(show).toContain("A\tnew.md");
  });

  it("revertCommit produces a new commit visible to system git", async () => {
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await writeFile(join(repoDir, "note.md"), "one\n", "utf8");

    await service.add({ repoPath: repoDir, filepath: "note.md" });
    await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await writeFile(join(repoDir, "note.md"), "two\n", "utf8");
    await service.add({ repoPath: repoDir, filepath: "note.md" });
    const changeCommit = await service.commit({
      repoPath: repoDir,
      message: "change",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    const revertCommit = await service.revertCommit({
      repoPath: repoDir,
      oid: changeCommit,
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(revertCommit).toHaveLength(40);

    const fileAtHead = await runGit(repoDir, ["show", "HEAD:note.md"]);
    const status = await runGit(repoDir, ["status", "--porcelain"]);

    expect(fileAtHead).toBe("one");
    expect(status).toBe("");
  });

  // ---------------------------------------------------------------------------
  // MET-83 Phase 1 — reverse direction: a system-git operation must be
  // faithfully reflected in the app's reported state (status / log / branches).
  // ---------------------------------------------------------------------------
  describe("system git → app-reported state", () => {
    it("reflects a commit made by system git in service.log and service.status", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "hello\n", "utf8");

      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "system commit");
      const head = await runGit(repoDir, ["rev-parse", "HEAD"]);

      const log = await service.log({ repoPath: repoDir });
      expect(log[0]?.oid).toBe(head);
      expect(log[0]?.commit.message.trim()).toBe("system commit");

      const status = await service.status({ repoPath: repoDir });
      expect(status.staged).toEqual([]);
      expect(status.unstaged).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    it("reflects a branch created and checked out by system git", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "hello\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "base");

      await runGit(repoDir, ["branch", "feature"]);
      await runGit(repoDir, ["checkout", "feature"]);

      const branches = await service.listBranches({ repoPath: repoDir });
      expect(branches).toEqual(expect.arrayContaining(["feature", "main"]));

      const status = await service.status({ repoPath: repoDir });
      expect(status.currentBranch).toBe("feature");
    });

    it("surfaces an external working-tree edit as unstaged", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "one\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "base");

      await writeFile(join(repoDir, "note.md"), "two\n", "utf8");

      const status = await service.status({ repoPath: repoDir });
      expect(status.unstaged.map((change) => change.path)).toContain("note.md");
      expect(status.staged).toEqual([]);
    });

    it("surfaces a change staged by system git as staged", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "one\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "base");

      await writeFile(join(repoDir, "note.md"), "two\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);

      const status = await service.status({ repoPath: repoDir });
      expect(status.staged.map((change) => change.path)).toContain("note.md");
      expect(status.unstaged).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // MET-83 Phase 2 — compatibility scenarios with deterministic assertions:
  // .gitignore, status parity, log parity, branch/switch roundtrip, checkout
  // restore. Each asserts the app agrees with the system `git` binary.
  // ---------------------------------------------------------------------------
  describe("git compatibility scenarios", () => {
    it("excludes .gitignore-ignored files from untracked status (parity with system git)", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, ".gitignore"), "ignored.txt\n", "utf8");
      await writeFile(join(repoDir, "ignored.txt"), "secret\n", "utf8");
      await writeFile(join(repoDir, "tracked.txt"), "visible\n", "utf8");

      const status = await service.status({ repoPath: repoDir });
      expect(status.untracked).toEqual(
        expect.arrayContaining([".gitignore", "tracked.txt"]),
      );
      expect(status.untracked).not.toContain("ignored.txt");

      const porcelain = await runGit(repoDir, ["status", "--porcelain"]);
      expect(porcelain).toContain("tracked.txt");
      expect(porcelain).not.toContain("ignored.txt");
    });

    it("status parity: service categories agree with git status --porcelain", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "keep.md"), "keep\n", "utf8");
      await runGit(repoDir, ["add", "keep.md"]);
      await commitViaGit(repoDir, "base");

      await writeFile(join(repoDir, "keep.md"), "keep changed\n", "utf8");
      await writeFile(join(repoDir, "new.md"), "new\n", "utf8");

      const status = await service.status({ repoPath: repoDir });
      const porcelain = await runGit(repoDir, ["status", "--porcelain"]);

      expect(new Set(status.unstaged.map((change) => change.path))).toEqual(
        new Set(["keep.md"]),
      );
      expect(new Set(status.untracked)).toEqual(new Set(["new.md"]));
      expect(porcelain).toContain("M keep.md");
      expect(porcelain).toContain("?? new.md");
    });

    it("log parity: service.log matches system git log order and messages", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      const messages = ["first", "second", "third"];
      for (const message of messages) {
        await writeFile(join(repoDir, `${message}.md`), `${message}\n`, "utf8");
        await runGit(repoDir, ["add", `${message}.md`]);
        await commitViaGit(repoDir, message);
      }

      const log = await service.log({ repoPath: repoDir });
      const gitOids = (await runGit(repoDir, ["log", "--format=%H"])).split("\n");
      const gitMessages = (
        await runGit(repoDir, ["log", "--format=%s"])
      ).split("\n");

      expect(log.map((entry) => entry.oid)).toEqual(gitOids);
      expect(log.map((entry) => entry.commit.message.trim())).toEqual(
        gitMessages,
      );
    });

    it("branch/switch roundtrip works in both directions", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "hello\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "base");

      // App creates + switches → system git observes the current branch.
      await service.createBranch({ repoPath: repoDir, ref: "feature" });
      await service.switchBranch({ repoPath: repoDir, ref: "feature" });
      expect(await runGit(repoDir, ["branch", "--show-current"])).toBe(
        "feature",
      );

      // System git creates + switches → the app observes the current branch.
      await service.switchBranch({ repoPath: repoDir, ref: "main" });
      await runGit(repoDir, ["checkout", "-b", "hotfix"]);
      const status = await service.status({ repoPath: repoDir });
      expect(status.currentBranch).toBe("hotfix");

      const branches = await service.listBranches({ repoPath: repoDir });
      expect(branches).toEqual(
        expect.arrayContaining(["main", "feature", "hotfix"]),
      );
    });

    it("checkoutPaths restores a file to its committed content on disk and per system git", async () => {
      await service.init({ repoPath: repoDir, defaultBranch: "main" });
      await writeFile(join(repoDir, "note.md"), "one\n", "utf8");
      await runGit(repoDir, ["add", "note.md"]);
      await commitViaGit(repoDir, "base");

      await writeFile(join(repoDir, "note.md"), "two\n", "utf8");
      await service.checkoutPaths({
        repoPath: repoDir,
        ref: "HEAD",
        filepaths: ["note.md"],
        force: true,
      });

      const onDisk = await readFile(join(repoDir, "note.md"), "utf8");
      expect(onDisk).toBe("one\n");
      expect(await runGit(repoDir, ["status", "--porcelain"])).toBe("");
    });
  });
});
