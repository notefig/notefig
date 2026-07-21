import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IsomorphicGitService } from "./isomorphicGitService";
import {
  GIT_AUTHOR,
  NodeGitStorageHost,
  commitViaGit,
  hasSystemGit,
  runGit,
  runGitAllowFail,
  stubCompressionStreams,
} from "./realGit.testkit";

const describeRealGit = hasSystemGit ? describe : describe.skip;

/**
 * MET-83 Phase 3 — lock contention / concurrency.
 *
 * The app path (isomorphic-git) and the system `git` binary share the same
 * on-disk repository but coordinate through *different* locking primitives:
 * `NodeGitStorageHost.lock()` is an in-process `Set`, while system git uses
 * on-disk `*.lock` files. These tests assert the safety property MET-15 called
 * out: concurrent operation may drop an update (last-writer-wins on a ref), but
 * it must never corrupt the object database, refs, or index. Corruption — not a
 * lost update — is the failure we guard against.
 */
describeRealGit("[real-git] IsomorphicGitService concurrency & lock safety", () => {
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
    repoDir = await mkdtemp(join(tmpdir(), "metrists-git-concurrency-"));
    service = new IsomorphicGitService(new NodeGitStorageHost(repoDir));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function commitBaseline(): Promise<void> {
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await writeFile(join(repoDir, "seed.md"), "seed\n", "utf8");
    await service.add({ repoPath: repoDir, filepath: "seed.md" });
    await service.commit({
      repoPath: repoDir,
      message: "seed",
      author: GIT_AUTHOR,
      committer: GIT_AUTHOR,
    });
  }

  it("keeps the repository uncorrupted when app and system git commit concurrently", async () => {
    await commitBaseline();

    // Several rounds to widen the window in which the two writers actually overlap.
    for (let round = 0; round < 5; round += 1) {
      const appFile = `app-${round}.md`;
      const systemFile = `system-${round}.md`;
      await writeFile(join(repoDir, appFile), `app ${round}\n`, "utf8");
      await writeFile(join(repoDir, systemFile), `system ${round}\n`, "utf8");

      const appCommit = service.addAllAndCommit({
        repoPath: repoDir,
        message: `app checkpoint ${round}`,
        author: GIT_AUTHOR,
      });
      const systemCommit = (async () => {
        await runGit(repoDir, ["add", systemFile]);
        await commitViaGit(repoDir, `system commit ${round}`);
      })();

      // A ref race may reject one side; that is acceptable. Corruption is not.
      await Promise.allSettled([appCommit, systemCommit]);

      // Object database and refs stay structurally intact (dangling commits from a
      // lost ref race are reported by fsck but do not make it exit non-zero).
      const fsck = await runGitAllowFail(repoDir, ["fsck", "--full"]);
      expect(fsck.code).toBe(0);
      // HEAD still resolves to a real commit and the index is still parseable.
      expect(await runGit(repoDir, ["rev-parse", "HEAD"])).toHaveLength(40);
      expect((await runGitAllowFail(repoDir, ["status"])).code).toBe(0);
      // The app can still read the repository it shares with system git.
      const log = await service.log({ repoPath: repoDir });
      expect(log.length).toBeGreaterThan(0);
    }
  });

  it("does not use system git's index.lock, and leaves a repo system git can still read", async () => {
    await commitBaseline();
    await writeFile(join(repoDir, "change.md"), "change\n", "utf8");

    // Simulate an interrupted system-git operation that left a stale lock behind.
    const lockPath = join(repoDir, ".git", "index.lock");
    await writeFile(lockPath, "", "utf8");

    // System git refuses to touch the index while the lock is present...
    const blocked = await runGitAllowFail(repoDir, ["add", "change.md"]);
    expect(blocked.code).not.toBe(0);

    // ...but the app path (isomorphic-git) does not honor index.lock, so it
    // proceeds. This documents the interop boundary: the app is not blocked by a
    // stale system-git lock.
    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "app commit despite stale lock",
      author: GIT_AUTHOR,
    });
    expect(oid).not.toBeNull();

    // Once the stale lock clears, system git sees an intact repo with the commit.
    await rm(lockPath, { force: true });
    expect((await runGitAllowFail(repoDir, ["fsck", "--full"])).code).toBe(0);
    expect(await runGit(repoDir, ["rev-parse", "HEAD"])).toBe(oid);
    expect(await runGit(repoDir, ["log", "-1", "--format=%s"])).toBe(
      "app commit despite stale lock",
    );
  });
});
