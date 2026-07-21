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
} from "./realGit.test-helpers";

const describeRealGit = hasSystemGit ? describe : describe.skip;

/**
 * MET-83 Phase 3 — lock contention / concurrent access.
 *
 * The app path (isomorphic-git) and the system `git` binary share one on-disk
 * repository but coordinate through *different* locking primitives:
 * `NodeGitStorageHost.lock()` is an in-process `Set`, while system git uses
 * on-disk `*.lock` files — neither observes the other's lock. What keeps this
 * safe is that both write every file atomically (temp + rename): the app host's
 * `writeFileAtomic` mirrors production's Rust `fs_ops::atomic_write`, so a
 * concurrent reader never sees a torn ref/index/object. The guarantee we assert:
 *   - true concurrency may DROP an update (last writer wins a ref) but must never
 *     corrupt the object database, refs, or index;
 *   - sequential interop must additionally lose no history;
 *   - a stale `index.lock` blocks system git but not the app, and leaves an
 *     intact repo once cleared.
 * A dropped update is acceptable (canonical git has the same exposure with no
 * ref/index locks); corruption is not.
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

    // Fire both writers at the same instant, several rounds, to actually overlap
    // their ref/index/object writes. Atomic writes mean the loser of a ref race is
    // dropped (its commit dangles) but nothing is ever torn or corrupt.
    for (let round = 0; round < 6; round += 1) {
      await writeFile(join(repoDir, `app-${round}.md`), `app ${round}\n`, "utf8");
      await writeFile(
        join(repoDir, `system-${round}.md`),
        `system ${round}\n`,
        "utf8",
      );

      const appCommit = service.addAllAndCommit({
        repoPath: repoDir,
        message: `app checkpoint ${round}`,
        author: GIT_AUTHOR,
      });
      const systemCommit = (async () => {
        await runGit(repoDir, ["add", `system-${round}.md`]);
        await commitViaGit(repoDir, `system commit ${round}`);
      })();

      // A ref race may reject one side; that is acceptable, corruption is not.
      await Promise.allSettled([appCommit, systemCommit]);

      // Object database + refs intact (a dropped update leaves a *dangling*
      // commit, which fsck reports without exiting non-zero — real corruption,
      // a missing/torn object or bad ref, would fail here).
      expect((await runGitAllowFail(repoDir, ["fsck", "--full"])).code).toBe(0);
      // HEAD resolves to a real commit and the index is parseable by system git.
      expect(await runGit(repoDir, ["rev-parse", "HEAD"])).toHaveLength(40);
      expect((await runGitAllowFail(repoDir, ["status"])).code).toBe(0);
      // The app can still read the repository it shares with system git.
      expect((await service.log({ repoPath: repoDir })).length).toBeGreaterThan(0);
    }
  }, 30000);

  it("interleaves app and system git commits on one repo with no corruption or lost history", async () => {
    await commitBaseline();

    // Newest-first, matching `git log` / service.log ordering.
    const expectedSubjects = ["seed"];

    const appCommit = async (n: number): Promise<void> => {
      await writeFile(join(repoDir, `app-${n}.md`), `app ${n}\n`, "utf8");
      await service.addAllAndCommit({
        repoPath: repoDir,
        message: `app ${n}`,
        author: GIT_AUTHOR,
      });
      expectedSubjects.unshift(`app ${n}`);
    };

    const systemGitCommit = async (n: number): Promise<void> => {
      await writeFile(join(repoDir, `system-${n}.md`), `system ${n}\n`, "utf8");
      await runGit(repoDir, ["add", `system-${n}.md`]);
      await commitViaGit(repoDir, `system ${n}`);
      expectedSubjects.unshift(`system ${n}`);
    };

    // Alternate the two writers against the same index/refs/objects. Each must
    // build correctly on the HEAD and index the other just left behind.
    await appCommit(1);
    await systemGitCommit(1);
    await appCommit(2);
    await systemGitCommit(2);

    // Object database and refs are intact.
    expect((await runGitAllowFail(repoDir, ["fsck", "--full"])).code).toBe(0);

    // Both tools agree on the full, ordered history — no commit was lost.
    const gitSubjects = (
      await runGit(repoDir, ["log", "--format=%s"])
    ).split("\n");
    expect(gitSubjects).toEqual(expectedSubjects);

    const serviceLog = await service.log({ repoPath: repoDir });
    expect(serviceLog.map((entry) => entry.commit.message.trim())).toEqual(
      expectedSubjects,
    );

    // The shared index/working tree is clean per both the app and system git.
    expect(await runGit(repoDir, ["status", "--porcelain"])).toBe("");
    const status = await service.status({ repoPath: repoDir });
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
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
