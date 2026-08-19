/**
 * Dual-repo isolation suite.
 *
 * A workspace can contain both the user's own repository (`<ws>/.git`, created
 * and driven by the system `git` binary here) and the app's hidden history
 * repository (`<ws>/.metrists/.git`, same worktree). The invariant under test:
 * the app's git operations target the history repo and NEVER read from or
 * write to the user's `.git` — not its refs, not its index (statusMatrix
 * rewrites the index of whatever gitdir it runs against), not its worktree
 * view of staged state.
 *
 * Written red against a gitdir-fallback bug that aimed the desktop's git
 * calls at the user's repo; the type system now prevents that class, but
 * isomorphic-git can still internally reach for `<dir>/.git` (its
 * statusMatrix ignore check did exactly that), which only behavioral
 * isolation tests like these can catch.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IsomorphicGitService } from "./isomorphicGitService";
import {
  NodeGitStorageHost,
  commitViaGit,
  hasSystemGit,
  runGit,
} from "./realGit.test-helpers";

const describeRealGit = hasSystemGit ? describe : describe.skip;

const HISTORY_GITDIR = (ws: string) => join(ws, ".metrists", ".git");
const AUTHOR = { name: "Notefig", email: "git@notefig.com" };

/** Run system `git` against the history repo (worktree = the workspace). */
function runHistoryGit(ws: string, args: string[]): Promise<string> {
  return runGit(ws, [
    "--git-dir",
    HISTORY_GITDIR(ws),
    "--work-tree",
    ws,
    ...args,
  ]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Content hash of every file under `root`, keyed by relative path. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        const data = await readFile(join(root, childRel));
        out[childRel] = createHash("sha1").update(data).digest("hex");
      }
    }
  };
  await walk("");
  return out;
}

const snapshotUserGit = (ws: string) => snapshotDir(join(ws, ".git"));

/** User repo with README.md + note.md committed, driven by system git. */
async function initUserRepo(ws: string): Promise<void> {
  await runGit(ws, ["init", "-b", "main"]);
  await writeFile(join(ws, "README.md"), "readme v1\n", "utf8");
  await writeFile(join(ws, "note.md"), "v1\n", "utf8");
  await runGit(ws, ["add", "."]);
  await commitViaGit(ws, "user: initial");
  // Mirror history-service's stealth exclude of the app root.
  await appendFile(join(ws, ".git", "info", "exclude"), ".metrists/\n");
}

/** History repo at .metrists/.git with one checkpoint, via explicit gitDir. */
async function initHistoryRepo(
  service: IsomorphicGitService,
  ws: string,
): Promise<{ initialCheckpointOid: string }> {
  const gitDir = HISTORY_GITDIR(ws);
  await service.init({ defaultBranch: "main" });
  // Mirror history-service.ts's own-exclude write.
  await appendFile(join(gitDir, "info", "exclude"), ".metrists/\n.git/\n");
  const oid = await service.addAllAndCommit({
    message: "checkpoint: initial",
    author: AUTHOR,
  });
  if (!oid) throw new Error("initial checkpoint produced no commit");
  return { initialCheckpointOid: oid };
}

describeRealGit("[real-git] dual-repo isolation (history repo vs user repo)", () => {
  let ws: string;
  let service: IsomorphicGitService;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "metrists-dual-repo-"));
    // One service per workspace, exactly like the desktop's registry.
    service = new IsomorphicGitService(new NodeGitStorageHost(ws), { repoPath: ws, gitDir: HISTORY_GITDIR(ws) });
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  describe("desktop hotpaths (inputs mirror packages/desktop/src/entities/git.ts)", () => {
    it("init creates the history repo, not a <ws>/.git", async () => {
      // entities/git.ts ensureWorkspaceGitInitialized
      await service.init({ defaultBranch: "main" });

      expect(await pathExists(join(HISTORY_GITDIR(ws), "HEAD"))).toBe(true);
      expect(await pathExists(join(ws, ".git"))).toBe(false);
    });

    it("init leaves an existing user repo byte-identical", async () => {
      await initUserRepo(ws);
      const before = await snapshotUserGit(ws);

      await service.init({ defaultBranch: "main" });

      expect(await snapshotUserGit(ws)).toEqual(before);
      expect(await pathExists(join(HISTORY_GITDIR(ws), "HEAD"))).toBe(true);
    });

    it("status reports the history repo's view, not the user's staging", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
      // The user deliberately stages a change in their own repo.
      await writeFile(join(ws, "README.md"), "readme v2 with more words\n", "utf8");
      await runGit(ws, ["add", "README.md"]);

      // entities/git.ts fetchGitRows
      const status = await service.status();

      // The history repo committed README v1, so its view of the edit is an
      // unstaged modification — the user's staged entry must not leak in.
      expect(status.staged).toEqual([]);
      expect(status.unstaged.map((c) => c.path)).toContain("README.md");
    });

    it("status never modifies the user's .git (index included)", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
      await writeFile(join(ws, "README.md"), "readme v2 with more words\n", "utf8");
      await runGit(ws, ["add", "README.md"]);
      const before = await snapshotUserGit(ws);
      const porcelainBefore = await runGit(ws, ["status", "--porcelain"]);

      await service.status();

      expect(await snapshotUserGit(ws)).toEqual(before);
      expect(await runGit(ws, ["status", "--porcelain"])).toBe(porcelainBefore);
    });

    it("log returns history checkpoints, not the user's commits", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);

      // entities/git.ts fetchGitRows
      const entries = await service.log({ depth: 25 });

      const messages = entries.map((entry) => entry.commit.message.trim());
      expect(messages).toContain("checkpoint: initial");
      expect(messages).not.toContain("user: initial");
    });

    it("saveCheckpoint's addAllAndCommit commits to history and preserves the user's staging", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
      // The user is mid-flow: a.md deliberately staged, b.md deliberately not.
      await writeFile(join(ws, "a.md"), "a\n", "utf8");
      await writeFile(join(ws, "b.md"), "b\n", "utf8");
      await runGit(ws, ["add", "a.md"]);
      const before = await snapshotUserGit(ws);

      // entities/git.ts saveCheckpoint
      const oid = await service.addAllAndCommit({
        message: "Commit",
        author: AUTHOR,
      });

      expect(oid).not.toBeNull();
      // The user's repo — commits, refs, and partial staging — is untouched.
      expect(await snapshotUserGit(ws)).toEqual(before);
      // The checkpoint landed in the history repo with both files.
      expect(await runHistoryGit(ws, ["log", "-1", "--pretty=%s"])).toBe(
        "Commit",
      );
      expect(await runHistoryGit(ws, ["show", "HEAD:a.md"])).toBe("a");
      expect(await runHistoryGit(ws, ["show", "HEAD:b.md"])).toBe("b");
    });

    it("revertCommit reverts a history checkpoint without touching the user's repo", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
      // Second checkpoint changes note.md, mirrored into the user's repo so
      // both are clean before the revert. Content length differs from v1 —
      // a same-size same-second edit is invisible to the stat-cache walk.
      await writeFile(join(ws, "note.md"), "note v2\n", "utf8");
      const checkpoint2 = await service.addAllAndCommit({
        message: "checkpoint: v2",
        author: AUTHOR,
      });
      if (!checkpoint2) throw new Error("checkpoint 2 produced no commit");
      await runGit(ws, ["add", "note.md"]);
      await commitViaGit(ws, "user: v2");
      const before = await snapshotUserGit(ws);

      // entities/git.ts revertToCheckpoint
      const revertOid = await service.revertCommit({
        oid: checkpoint2,
        message: `Revert ${checkpoint2.slice(0, 7)}`,
        author: AUTHOR,
      });

      expect(revertOid).not.toBeNull();
      expect(await readFile(join(ws, "note.md"), "utf8")).toBe("v1\n");
      expect(await runHistoryGit(ws, ["log", "-1", "--pretty=%s"])).toBe(
        `Revert ${checkpoint2.slice(0, 7)}`,
      );
      // The user's repo keeps its own history; the worktree edit shows up
      // there as an ordinary unstaged change, nothing more.
      expect(await snapshotUserGit(ws)).toEqual(before);
    });

    it("abortRevert restores the history repo's HEAD, not the user's", async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
      // History moves ahead of the user's repo, then the worktree gets dirty.
      await writeFile(join(ws, "note.md"), "history-v2\n", "utf8");
      const checkpoint2 = await service.addAllAndCommit({
        message: "checkpoint: v2",
        author: AUTHOR,
      });
      if (!checkpoint2) throw new Error("checkpoint 2 produced no commit");
      await writeFile(join(ws, "note.md"), "dirty\n", "utf8");
      const before = await snapshotUserGit(ws);

      // entities/git.ts abortRevert
      await service.abortRevert();

      // History HEAD wins — not the user's HEAD (which still has v1).
      expect(await readFile(join(ws, "note.md"), "utf8")).toBe("history-v2\n");
      expect(await snapshotUserGit(ws)).toEqual(before);
    });
  });

  describe("kernel methods must not fall back to the user's .git", () => {
    let before: Record<string, string>;

    beforeEach(async () => {
      await initUserRepo(ws);
      await initHistoryRepo(service, ws);
    });

    it("index operations (add/unstage/remove/commit) stay in the history index", async () => {
      await writeFile(join(ws, "extra.md"), "extra\n", "utf8");
      // The user deliberately stages the same file in their own repo — it
      // must survive every history-index operation below.
      await runGit(ws, ["add", "extra.md"]);
      before = await snapshotUserGit(ws);

      await service.add({ filepath: "extra.md" });
      expect(await runHistoryGit(ws, ["ls-files"])).toContain("extra.md");

      await service.unstage({ filepath: "extra.md" });
      expect(await runHistoryGit(ws, ["ls-files"])).not.toContain("extra.md");

      await service.remove({ filepath: "note.md" });
      expect(await runHistoryGit(ws, ["ls-files"])).not.toContain("note.md");

      await service.add({ filepath: "note.md" });
      await service.commit({
        message: "kernel commit",
        author: AUTHOR,
        committer: AUTHOR,
      });
      expect(await runHistoryGit(ws, ["log", "-1", "--pretty=%s"])).toBe(
        "kernel commit",
      );

      // Through it all: the user's .git byte-identical, staging intact.
      expect(await snapshotUserGit(ws)).toEqual(before);
      expect(await runGit(ws, ["ls-files"])).toContain("extra.md");
      expect(await runGit(ws, ["log", "-1", "--pretty=%s"])).toBe(
        "user: initial",
      );
    });

    it("branch operations target the history repo only", async () => {
      await runGit(ws, ["branch", "user-only"]);
      before = await snapshotUserGit(ws);

      await service.createBranch({ ref: "alt" });
      await service.switchBranch({ ref: "alt" });

      const branches = await service.listBranches();
      expect(branches).toContain("alt");
      expect(branches).not.toContain("user-only");
      expect(await runHistoryGit(ws, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/alt",
      );
      expect(await runGit(ws, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main",
      );
      expect(await snapshotUserGit(ws)).toEqual(before);
    });

    it("checkoutPaths and readTextFile serve the history repo's objects", async () => {
      // History HEAD moves to v2 while the user's HEAD stays at v1 — the v2
      // commit exists ONLY in the history repo, so reads that resolve prove
      // which repo answered.
      await writeFile(join(ws, "note.md"), "history-v2\n", "utf8");
      const checkpoint2 = await service.addAllAndCommit({
        message: "checkpoint: v2",
        author: AUTHOR,
      });
      if (!checkpoint2) throw new Error("checkpoint 2 produced no commit");
      await writeFile(join(ws, "note.md"), "dirty\n", "utf8");
      before = await snapshotUserGit(ws);

      expect(
        await service.readTextFile({ ref: checkpoint2, filepath: "note.md" }),
      ).toBe("history-v2\n");

      await service.checkoutPaths({ filepaths: ["note.md"] });

      expect(await readFile(join(ws, "note.md"), "utf8")).toBe("history-v2\n");
      expect(await snapshotUserGit(ws)).toEqual(before);
    });
  });

  describe("history-repo exclude handling", () => {
    it("status honors the history repo's own info/exclude without a user repo", async () => {
      // No user .git at all — the history repo's exclude is the only one.
      const gitDir = HISTORY_GITDIR(ws);
      await service.init({ defaultBranch: "main" });
      await appendFile(join(gitDir, "info", "exclude"), ".metrists/\n.git/\n");
      await writeFile(join(ws, "note.md"), "v1\n", "utf8");
      await writeFile(join(ws, ".metrists", "tasks.json"), "{}\n", "utf8");

      const status = await service.status();

      // .metrists/ is excluded by the history repo's own exclude file —
      // nothing under it may surface as untracked.
      expect(status.untracked).toEqual(["note.md"]);
    });
  });
});
