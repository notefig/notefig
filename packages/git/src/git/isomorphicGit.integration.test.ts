import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
  lstat,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Buffer } from "node:buffer";
import { dirname, join, resolve } from "node:path";
import git from "isomorphic-git";

import { createIsomorphicGitFs } from "./isomorphicGitFs";
import { IsomorphicGitService } from "./isomorphicGitService";
import type {
  GitHostDirEntry,
  GitHostLStatResult,
  GitHostStatResult,
  GitStorageHost,
} from "./types";

class MockPlatformStorageHost implements GitStorageHost {
  private locks = new Set<string>();

  constructor(private readonly rootDir: string) {}

  private resolvePath(path: string): string {
    return path.startsWith("/") ? path : resolve(this.rootDir, path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const buffer = await readFile(this.resolvePath(path));
    return new Uint8Array(buffer);
  }

  async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Uint8Array.from(data));
  }

  async renameAtomic(from: string, to: string): Promise<void> {
    const fromPath = this.resolvePath(from);
    const toPath = this.resolvePath(to);
    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
  }

  async deleteFile(path: string): Promise<void> {
    await rm(this.resolvePath(path));
  }

  async stat(path: string): Promise<GitHostStatResult> {
    try {
      const stats = await stat(this.resolvePath(path));
      return {
        exists: true,
        isFile: stats.isFile(),
        isDir: stats.isDirectory(),
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
      };
    } catch {
      return { exists: false, isFile: false, isDir: false };
    }
  }

  async lstat(path: string): Promise<GitHostLStatResult> {
    try {
      const stats = await lstat(this.resolvePath(path));
      return {
        exists: true,
        isFile: stats.isFile(),
        isDir: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
      };
    } catch {
      return {
        exists: false,
        isFile: false,
        isDir: false,
        isSymbolicLink: false,
      };
    }
  }

  async readDir(path: string): Promise<GitHostDirEntry[]> {
    const entries = await readdir(this.resolvePath(path), {
      withFileTypes: true,
    });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDir: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async createDir(path: string): Promise<void> {
    await mkdir(this.resolvePath(path), { recursive: true });
  }

  async removeDir(path: string): Promise<void> {
    await rm(this.resolvePath(path), { recursive: true, force: false });
  }

  async readLink(path: string): Promise<string> {
    return readlink(this.resolvePath(path));
  }

  async createSymlink(target: string, path: string): Promise<void> {
    await symlink(target, this.resolvePath(path));
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(this.resolvePath(path), mode);
  }

  async lock(name: string): Promise<void> {
    if (this.locks.has(name)) {
      throw new Error(`Lock '${name}' already held`);
    }
    this.locks.add(name);
  }

  async unlock(name: string): Promise<void> {
    this.locks.delete(name);
  }
}

class MissingControlFilesStatHost extends MockPlatformStorageHost {
  override async stat(path: string): Promise<GitHostStatResult> {
    if (path.endsWith("/.git/HEAD") || path.endsWith("/.git/config")) {
      return { exists: false, isFile: false, isDir: false };
    }

    return super.stat(path);
  }
}

describe("createIsomorphicGitFs + IsomorphicGitService", () => {
  let repoDir: string;
  let host: MockPlatformStorageHost;
  const originalCompressionStream = globalThis.CompressionStream;
  const originalDecompressionStream = globalThis.DecompressionStream;

  beforeAll(() => {
    // isomorphic-git's CompressionStream path is unstable in this runtime.
    // Force the pako path for deterministic deflate/inflate behavior in tests.
    (
      globalThis as { CompressionStream?: typeof CompressionStream }
    ).CompressionStream = undefined;
    (
      globalThis as { DecompressionStream?: typeof DecompressionStream }
    ).DecompressionStream = undefined;
  });

  afterAll(() => {
    (
      globalThis as { CompressionStream?: typeof CompressionStream }
    ).CompressionStream = originalCompressionStream;
    (
      globalThis as { DecompressionStream?: typeof DecompressionStream }
    ).DecompressionStream = originalDecompressionStream;
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "metrists-git-it-"));
    host = new MockPlatformStorageHost(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("maps host storage through isomorphic-git init", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const headFile = await host.readFile(join(repoDir, ".git/HEAD"));
    const headText = Buffer.from(headFile).toString("utf8");
    expect(headText).toContain("refs/heads/main");

    const configFile = await host.readFile(join(repoDir, ".git/config"));
    const configText = Buffer.from(configFile).toString("utf8");
    expect(configText).toContain("[core]");
  });

  it("repairs incomplete .git metadata on init", async () => {
    const service = new IsomorphicGitService(host);

    await host.createDir(join(repoDir, ".git"));
    await host.createDir(join(repoDir, ".git/objects"));
    await host.createDir(join(repoDir, ".git/refs"));

    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const headFile = await host.readFile(join(repoDir, ".git/HEAD"));
    const headText = Buffer.from(headFile).toString("utf8");
    expect(headText).toContain("refs/heads/main");

    const configFile = await host.readFile(join(repoDir, ".git/config"));
    const configText = Buffer.from(configFile).toString("utf8");
    expect(configText).toContain("repositoryformatversion = 0");
  });

  it("writes control files on repeated init calls", async () => {
    const service = new IsomorphicGitService(host);

    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const headFile = await host.readFile(join(repoDir, ".git/HEAD"));
    const configFile = await host.readFile(join(repoDir, ".git/config"));

    expect(Buffer.from(headFile).toString("utf8")).toContain("refs/heads/main");
    expect(Buffer.from(configFile).toString("utf8")).toContain("[core]");
  });

  it("returns success when kernel init fails but control files exist", async () => {
    const service = new IsomorphicGitService(host);
    const initSpy = jest
      .spyOn(git, "init")
      .mockRejectedValue(new Error("forced init failure"));

    try {
      await expect(
        service.init({ repoPath: repoDir, defaultBranch: "main" }),
      ).resolves.toBeUndefined();

      const headFile = await host.readFile(join(repoDir, ".git/HEAD"));
      const configFile = await host.readFile(join(repoDir, ".git/config"));

      expect(Buffer.from(headFile).toString("utf8")).toContain(
        "refs/heads/main",
      );
      expect(Buffer.from(configFile).toString("utf8")).toContain("[core]");
    } finally {
      initSpy.mockRestore();
    }
  });

  it("throws when kernel init fails and control files are missing", async () => {
    const missingStatHost = new MissingControlFilesStatHost(repoDir);
    const service = new IsomorphicGitService(missingStatHost);
    const initSpy = jest
      .spyOn(git, "init")
      .mockRejectedValue(new Error("forced init failure"));

    try {
      await expect(
        service.init({ repoPath: repoDir, defaultBranch: "main" }),
      ).rejects.toMatchObject({
        name: "GitError",
        code: "CorruptRepository",
      });
    } finally {
      initSpy.mockRestore();
    }
  });

  it("reports untracked files before first commit", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("hello\n"),
    );

    const before = await service.status({ repoPath: repoDir });
    expect(before.untracked).toEqual(["note.md"]);
  });

  it("returns empty log for initialized repo without commits", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await expect(service.log({ repoPath: repoDir })).resolves.toEqual([]);
  });

  it("returns status for initialized repo without commits", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const status = await service.status({ repoPath: repoDir });

    expect(status.repoPath).toBe(repoDir);
    expect(status.currentBranch).toBe("main");
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.conflicts).toEqual([]);
  });

  it("throws RepoNotFound for status when repository is not initialized", async () => {
    const service = new IsomorphicGitService(host);

    await expect(service.status({ repoPath: repoDir })).rejects.toMatchObject({
      name: "GitError",
      code: "RepoNotFound",
    });
  });

  it("stages and commits via mock storage host", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("hello\n"),
    );

    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    const commit = await service.commit({
      repoPath: repoDir,
      message: "Add note",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });
    expect(commit).toHaveLength(40);
  });

  it("lists branches and supports branch creation", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await host.writeFileAtomic(
      join(repoDir, "a.md"),
      new TextEncoder().encode("a\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["a.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "init",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await service.createBranch({ repoPath: repoDir, ref: "feature/test" });

    const branches = await service.listBranches({ repoPath: repoDir });
    expect(branches).toEqual(expect.arrayContaining(["main", "feature/test"]));
  });

  it("supports switch branch and log per ref", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await host.writeFileAtomic(
      join(repoDir, "base.md"),
      new TextEncoder().encode("base\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["base.md"] });
    const baseCommit = await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await service.createBranch({ repoPath: repoDir, ref: "feature/test" });
    await service.switchBranch({ repoPath: repoDir, ref: "feature/test" });

    await host.writeFileAtomic(
      join(repoDir, "feature.md"),
      new TextEncoder().encode("feature\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["feature.md"] });
    const featureCommit = await service.commit({
      repoPath: repoDir,
      message: "feature",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    const featureStatus = await service.status({ repoPath: repoDir });
    expect(featureStatus.currentBranch).toBe("feature/test");

    await service.switchBranch({ repoPath: repoDir, ref: "main" });
    const mainStatus = await service.status({ repoPath: repoDir });
    expect(mainStatus.currentBranch).toBe("main");

    const mainLog = await service.log({ repoPath: repoDir, ref: "main" });
    const featureLog = await service.log({
      repoPath: repoDir,
      ref: "feature/test",
    });

    expect(mainLog[0]?.oid).toBe(baseCommit);
    expect(featureLog[0]?.oid).toBe(featureCommit);
    expect(featureLog[1]?.oid).toBe(baseCommit);
  });

  it("reports status transitions and restores file with checkoutPaths", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });
    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("hello\n"),
    );

    const untracked = await service.status({ repoPath: repoDir });
    expect(untracked.untracked).toEqual(["note.md"]);

    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    const staged = await service.status({ repoPath: repoDir });
    expect(staged.staged).toEqual([{ path: "note.md", type: "added" }]);

    await service.commit({
      repoPath: repoDir,
      message: "Add note",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    const clean = await service.status({ repoPath: repoDir });
    expect(clean.staged).toEqual([]);
    expect(clean.unstaged).toEqual([]);
    expect(clean.untracked).toEqual([]);

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("changed\n"),
    );
    const dirty = await service.status({ repoPath: repoDir });
    expect(dirty.unstaged).toEqual([{ path: "note.md", type: "modified" }]);

    await service.checkoutPaths({
      repoPath: repoDir,
      filepaths: ["note.md"],
    });

    const restoredText = await readFile(join(repoDir, "note.md"), "utf8");
    expect(restoredText).toBe("hello\n");

    const restored = await service.status({ repoPath: repoDir });
    expect(restored.unstaged).toEqual([]);
  });

  it("reports staged modifications and unstaged deletion accurately", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "2026-05-05.md"),
      new TextEncoder().encode("day 1\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "2026-05-06.md"),
      new TextEncoder().encode("day 2\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "h.md"),
      new TextEncoder().encode("hello\n"),
    );

    await service.add({
      repoPath: repoDir,
      filepath: ["2026-05-05.md", "2026-05-06.md", "h.md"],
    });
    await service.commit({
      repoPath: repoDir,
      message: "baseline",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "2026-05-05.md"),
      new TextEncoder().encode("day 1 updated\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "2026-05-06.md"),
      new TextEncoder().encode("day 2 updated\n"),
    );
    await host.deleteFile(join(repoDir, "h.md"));

    await service.add({
      repoPath: repoDir,
      filepath: ["2026-05-05.md", "2026-05-06.md"],
    });

    const status = await service.status({ repoPath: repoDir });

    expect(status.staged).toEqual(
      expect.arrayContaining([
        { path: "2026-05-05.md", type: "modified" },
        { path: "2026-05-06.md", type: "modified" },
      ]),
    );
    expect(status.unstaged).toEqual(
      expect.arrayContaining([{ path: "h.md", type: "deleted" }]),
    );
  });

  it("removes deleted files from index before commit", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("hello\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "baseline",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.deleteFile(join(repoDir, "note.md"));
    const before = await service.status({ repoPath: repoDir });
    expect(before.unstaged).toEqual(
      expect.arrayContaining([{ path: "note.md", type: "deleted" }]),
    );

    await service.remove({ repoPath: repoDir, filepath: "note.md" });
    const after = await service.status({ repoPath: repoDir });
    expect(after.unstaged).toEqual([]);
    expect(after.staged).toEqual(
      expect.arrayContaining([{ path: "note.md", type: "deleted" }]),
    );
  });

  it("addAllAndCommit stages mixed changes and commits once", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "keep.md"),
      new TextEncoder().encode("keep\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "delete.md"),
      new TextEncoder().encode("delete\n"),
    );
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

    await host.writeFileAtomic(
      join(repoDir, "keep.md"),
      new TextEncoder().encode("keep updated\n"),
    );
    await host.deleteFile(join(repoDir, "delete.md"));
    await host.writeFileAtomic(
      join(repoDir, "new.md"),
      new TextEncoder().encode("new\n"),
    );

    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "checkpoint",
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(oid).toBeTruthy();

    const status = await service.status({ repoPath: repoDir });
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it("addAllAndCommit stages mixed changes including deletions", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "keep.md"),
      new TextEncoder().encode("keep\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "delete-me.md"),
      new TextEncoder().encode("delete me\n"),
    );
    await service.add({
      repoPath: repoDir,
      filepath: ["keep.md", "delete-me.md"],
    });
    await service.commit({
      repoPath: repoDir,
      message: "baseline",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "keep.md"),
      new TextEncoder().encode("keep updated\n"),
    );
    await host.deleteFile(join(repoDir, "delete-me.md"));
    await host.writeFileAtomic(
      join(repoDir, "new.md"),
      new TextEncoder().encode("new file\n"),
    );

    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "checkpoint",
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(oid).toBeTruthy();

    const status = await service.status({ repoPath: repoDir });
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it("addAllAndCommit returns null when there are no changes", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "noop",
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(oid).toBeNull();
  });

  it("addAllAndCommit stages mixed changes and creates commit", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "a.md"),
      new TextEncoder().encode("a\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "b.md"),
      new TextEncoder().encode("b\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["a.md", "b.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "baseline",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "a.md"),
      new TextEncoder().encode("a updated\n"),
    );
    await host.writeFileAtomic(
      join(repoDir, "c.md"),
      new TextEncoder().encode("c\n"),
    );
    await host.deleteFile(join(repoDir, "b.md"));

    const oid = await service.addAllAndCommit({
      repoPath: repoDir,
      message: "mixed changes",
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(oid).toHaveLength(40);

    const clean = await service.status({ repoPath: repoDir });
    expect(clean.staged).toEqual([]);
    expect(clean.unstaged).toEqual([]);
    expect(clean.untracked).toEqual([]);
  });

  it("revertCommit creates a new commit restoring parent content", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("one\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    const baseCommit = await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("two\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
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

    const restoredText = await readFile(join(repoDir, "note.md"), "utf8");
    expect(restoredText).toBe("one\n");

    const log = await service.log({ repoPath: repoDir });
    expect(log[0]?.oid).toBe(revertCommit);
    expect(log[1]?.oid).toBe(changeCommit);
    expect(log[2]?.oid).toBe(baseCommit);
  });

  it("revertCommit detects conflicts when HEAD has diverged", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("one\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("two\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    const changeCommit = await service.commit({
      repoPath: repoDir,
      message: "change",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("three\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "change again",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await expect(
      service.revertCommit({
        repoPath: repoDir,
        oid: changeCommit,
        author: { name: "Metrists", email: "dev@metrists.app" },
      }),
    ).rejects.toMatchObject({
      name: "GitError",
      code: "MergeRequired",
    });

    const currentText = await readFile(join(repoDir, "note.md"), "utf8");
    expect(currentText).toBe("three\n");
  });

  it("revertCommit is a no-op when HEAD is already reverted", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("one\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("two\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    const changeCommit = await service.commit({
      repoPath: repoDir,
      message: "change",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    // Revert the change once
    await service.revertCommit({
      repoPath: repoDir,
      oid: changeCommit,
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    const currentText = await readFile(join(repoDir, "note.md"), "utf8");
    expect(currentText).toBe("one\n");

    // Revert the same commit again — HEAD already matches parent
    const secondRevert = await service.revertCommit({
      repoPath: repoDir,
      oid: changeCommit,
      author: { name: "Metrists", email: "dev@metrists.app" },
    });

    expect(secondRevert).toBeNull();

    const log = await service.log({ repoPath: repoDir });
    expect(log).toHaveLength(3);
  });

  it("abortRevert restores working tree to HEAD", async () => {
    const service = new IsomorphicGitService(host);
    await service.init({ repoPath: repoDir, defaultBranch: "main" });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("one\n"),
    );
    await service.add({ repoPath: repoDir, filepath: ["note.md"] });
    await service.commit({
      repoPath: repoDir,
      message: "base",
      author: { name: "Metrists", email: "dev@metrists.app" },
      committer: { name: "Metrists", email: "dev@metrists.app" },
    });

    await host.writeFileAtomic(
      join(repoDir, "note.md"),
      new TextEncoder().encode("dirty\n"),
    );

    await service.abortRevert({ repoPath: repoDir });

    const currentText = await readFile(join(repoDir, "note.md"), "utf8");
    expect(currentText).toBe("one\n");

    const status = await service.status({ repoPath: repoDir });
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  it("validates strict stat payloads in fs shim", async () => {
    const invalidHost: GitStorageHost = {
      readFile: async () => new Uint8Array(),
      writeFileAtomic: async () => undefined,
      renameAtomic: async () => undefined,
      deleteFile: async () => undefined,
      stat: async () =>
        ({
          exists: true,
          isFile: true,
          isDir: false,
        }) as unknown as GitHostStatResult,
      lstat: async () => ({
        exists: false,
        isFile: false,
        isDir: false,
        isSymbolicLink: false,
      }),
      readDir: async () => [],
      createDir: async () => undefined,
      removeDir: async () => undefined,
      readLink: async () => "",
      createSymlink: async () => undefined,
      chmod: async () => undefined,
      lock: async () => undefined,
      unlock: async () => undefined,
    };

    const fsClient = createIsomorphicGitFs(invalidHost) as unknown as {
      promises: { stat(path: string): Promise<unknown> };
    };
    await expect(fsClient.promises.stat("/repo/file")).rejects.toMatchObject({
      code: "EIO",
    });
  });
});

describe("IsomorphicGitService with a detached gitDir (gitdir separate from worktree)", () => {
  let workspaceDir: string;
  let gitDir: string;
  let host: MockPlatformStorageHost;
  let service: IsomorphicGitService;
  const originalCompressionStream = globalThis.CompressionStream;
  const originalDecompressionStream = globalThis.DecompressionStream;

  beforeAll(() => {
    (
      globalThis as { CompressionStream?: typeof CompressionStream }
    ).CompressionStream = undefined;
    (
      globalThis as { DecompressionStream?: typeof DecompressionStream }
    ).DecompressionStream = undefined;
  });

  afterAll(() => {
    (
      globalThis as { CompressionStream?: typeof CompressionStream }
    ).CompressionStream = originalCompressionStream;
    (
      globalThis as { DecompressionStream?: typeof DecompressionStream }
    ).DecompressionStream = originalDecompressionStream;
  });

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "detached-gitdir-it-"));
    gitDir = join(workspaceDir, ".meta", ".git");
    host = new MockPlatformStorageHost(workspaceDir);
    service = new IsomorphicGitService(host);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("never writes into <repoPath>/.git when gitDir is set", async () => {
    await service.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });

    const defaultGitDir = await host.stat(join(workspaceDir, ".git"));
    expect(defaultGitDir.exists).toBe(false);

    const historyHead = await host.readFile(join(gitDir, "HEAD"));
    expect(Buffer.from(historyHead).toString("utf8")).toContain(
      "refs/heads/main",
    );
  });

  it("round-trips checkpoint -> log -> diff (readTextFile) -> restore on a single file", async () => {
    await service.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });

    await writeFile(join(workspaceDir, "notes.md"), "# Notes\n\nfirst draft\n");
    const oid1 = await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "checkpoint: first draft",
      author: { name: "claude-code", email: "agent@metrists.local" },
    });
    expect(oid1).toBeTruthy();

    await writeFile(
      join(workspaceDir, "notes.md"),
      "# Notes\n\nfirst draft\n\nsecond paragraph\n",
    );
    const oid2 = await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "checkpoint: add second paragraph",
      author: { name: "claude-code", email: "agent@metrists.local" },
    });
    expect(oid2).toBeTruthy();

    const commits = await service.log({
      repoPath: workspaceDir,
      gitDir,
      filepath: "notes.md",
    });
    expect(commits.map((c) => c.commit.message.trim())).toEqual([
      "checkpoint: add second paragraph",
      "checkpoint: first draft",
    ]);

    const contentAtOid1 = await service.readTextFile({
      repoPath: workspaceDir,
      gitDir,
      ref: oid1 as string,
      filepath: "notes.md",
    });
    const contentAtOid2 = await service.readTextFile({
      repoPath: workspaceDir,
      gitDir,
      ref: oid2 as string,
      filepath: "notes.md",
    });
    expect(contentAtOid1).toBe("# Notes\n\nfirst draft\n");
    expect(contentAtOid2).toBe("# Notes\n\nfirst draft\n\nsecond paragraph\n");

    // "Restore" checkpoint 1: write its content back over the live file.
    await writeFile(join(workspaceDir, "notes.md"), contentAtOid1);
    const restored = await readFile(join(workspaceDir, "notes.md"), "utf8");
    expect(restored).toBe(contentAtOid1);
  });

  it("restoreTree jumps the worktree back and forward between snapshots", async () => {
    await service.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });
    const author = { name: "second", email: "second@example.com" };

    // Snapshot A: notes.md plus a file that never changes across snapshots.
    await writeFile(join(workspaceDir, "notes.md"), "v1\n");
    await writeFile(join(workspaceDir, "stable.md"), "unchanging\n");
    const oidA = (await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "A",
      author,
    })) as string;

    // Snapshot B: notes.md changed (different length — a same-size write in
    // the same millisecond is invisible to statusMatrix's stat shortcut),
    // extra.md added.
    await writeFile(join(workspaceDir, "notes.md"), "v2 with more text\n");
    await writeFile(join(workspaceDir, "extra.md"), "later\n");
    const oidB = (await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "B",
      author,
    })) as string;

    // An untracked file the restore must never touch, and a tracked file
    // identical in both snapshots that a surgical restore must not rewrite.
    await writeFile(join(workspaceDir, "scratch.txt"), "untracked\n");
    const stableBefore = await stat(join(workspaceDir, "stable.md"));

    // Back to A: notes.md reverts, extra.md is deleted, scratch.txt stays.
    const back = await service.restoreTree({
      repoPath: workspaceDir,
      gitDir,
      ref: oidA,
    });
    expect(back.restored).toEqual(["notes.md"]);
    expect(back.deleted).toEqual(["extra.md"]);
    expect(await readFile(join(workspaceDir, "notes.md"), "utf8")).toBe("v1\n");
    await expect(
      readFile(join(workspaceDir, "extra.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(workspaceDir, "scratch.txt"), "utf8")).toBe(
      "untracked\n",
    );
    // Unchanged file untouched on disk — not rewritten by the checkout.
    const stableAfter = await stat(join(workspaceDir, "stable.md"));
    expect(stableAfter.mtimeMs).toBe(stableBefore.mtimeMs);

    // restoreTree diffs against HEAD, so the restored state must be
    // committed before the next jump — exactly what the jump flow's safety
    // checkpoint does. This also sweeps in the untracked scratch.txt.
    const oidSafety = await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "safety",
      author,
    });
    expect(oidSafety).toBeTruthy();

    // Forward to B: extra.md comes back, notes.md advances, and scratch.txt
    // (absent at B, tracked by the safety commit) is removed — a jump
    // materializes the full snapshot.
    const forward = await service.restoreTree({
      repoPath: workspaceDir,
      gitDir,
      ref: oidB,
    });
    expect(forward.restored.sort()).toEqual(["extra.md", "notes.md"]);
    expect(forward.deleted).toEqual(["scratch.txt"]);
    expect(await readFile(join(workspaceDir, "notes.md"), "utf8")).toBe(
      "v2 with more text\n",
    );
    expect(await readFile(join(workspaceDir, "extra.md"), "utf8")).toBe(
      "later\n",
    );
  });

  it("restoreTree tolerates a file already gone from the worktree — its index entry still clears", async () => {
    await service.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });
    const author = { name: "second", email: "second@example.com" };

    await writeFile(join(workspaceDir, "notes.md"), "keep\n");
    const oidA = (await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "A",
      author,
    })) as string;
    await writeFile(join(workspaceDir, "extra.md"), "temp\n");
    await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "B",
      author,
    });

    // The user (or another process) already deleted the file on disk.
    await rm(join(workspaceDir, "extra.md"));

    const back = await service.restoreTree({
      repoPath: workspaceDir,
      gitDir,
      ref: oidA,
    });
    expect(back.deleted).toEqual(["extra.md"]);

    // Index reconciled: the deletion commits cleanly (no phantom index
    // entry), and after that the tree really is clean.
    const after = await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "after",
      author,
    });
    expect(after).toBeTruthy();
    const clean = await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "clean",
      author,
    });
    expect(clean).toBeNull();
  });

  it("restoreTree deletes even when the existence probe is broken (delete-first, not stat-first)", async () => {
    // Adapters map stat errors to exists:false. A stat-first delete would
    // read that as "already gone", skip the delete, and clear the index
    // over stale content — delete-first only consults stat to excuse a
    // delete that FAILED.
    class BrokenStatHost extends MockPlatformStorageHost {
      override async stat(path: string): Promise<GitHostStatResult> {
        if (path.endsWith("extra.md")) {
          return { exists: false, isFile: false, isDir: false };
        }
        return super.stat(path);
      }
    }
    const brokenService = new IsomorphicGitService(
      new BrokenStatHost(workspaceDir),
    );
    await brokenService.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });
    const author = { name: "second", email: "second@example.com" };

    await writeFile(join(workspaceDir, "notes.md"), "keep\n");
    const oidA = (await brokenService.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "A",
      author,
    })) as string;
    await writeFile(join(workspaceDir, "extra.md"), "stale if skipped\n");
    await brokenService.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "B",
      author,
    });

    const back = await brokenService.restoreTree({
      repoPath: workspaceDir,
      gitDir,
      ref: oidA,
    });
    expect(back.deleted).toEqual(["extra.md"]);
    // The file really is gone — the probe's lie never entered the path.
    await expect(
      readFile(join(workspaceDir, "extra.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("restoreTree fails loudly when a worktree deletion fails — never a silent partial restore", async () => {
    class FailingDeleteHost extends MockPlatformStorageHost {
      override async deleteFile(path: string): Promise<void> {
        if (path.endsWith("extra.md")) {
          throw new Error("EACCES: permission denied");
        }
        return super.deleteFile(path);
      }
    }
    const failingService = new IsomorphicGitService(
      new FailingDeleteHost(workspaceDir),
    );
    await failingService.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });
    const author = { name: "second", email: "second@example.com" };

    await writeFile(join(workspaceDir, "notes.md"), "keep\n");
    const oidA = (await failingService.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "A",
      author,
    })) as string;
    await writeFile(join(workspaceDir, "extra.md"), "cannot delete\n");
    await failingService.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "B",
      author,
    });

    await expect(
      failingService.restoreTree({
        repoPath: workspaceDir,
        gitDir,
        ref: oidA,
      }),
    ).rejects.toThrow(/permission denied/);
    // The stale file really is still there — the error told the truth.
    expect(await readFile(join(workspaceDir, "extra.md"), "utf8")).toBe(
      "cannot delete\n",
    );
  });

  it("two repos over one worktree stay independent when the primary excludes the secondary's dir", async () => {
    // The worktree's OWN default-gitdir repo (no gitDir override).
    await service.init({ repoPath: workspaceDir, defaultBranch: "main" });
    await writeFile(join(workspaceDir, "README.md"), "# project readme\n");
    await service.addAllAndCommit({
      repoPath: workspaceDir,
      message: "init project repo",
      author: { name: "user", email: "user@example.com" },
    });

    // Hide the secondary repo's directory from the primary via the
    // gitdir-local exclude (standard git: `.git/info/exclude`, never the
    // tracked .gitignore). init already created a stock file — append.
    const primaryExclude = join(workspaceDir, ".git", "info", "exclude");
    const stock = await readFile(primaryExclude, "utf8");
    await writeFile(primaryExclude, `${stock}.meta/\n`);

    // The SECONDARY detached-gitdir repo, same worktree.
    await service.init({
      repoPath: workspaceDir,
      gitDir,
      defaultBranch: "main",
    });
    await writeFile(join(workspaceDir, "notes.md"), "draft\n");
    await service.addAllAndCommit({
      repoPath: workspaceDir,
      gitDir,
      message: "checkpoint",
      author: { name: "second", email: "second@example.com" },
    });

    const ownStatus = await service.status({ repoPath: workspaceDir });
    // notes.md was never added to the primary repo, README.md is committed,
    // and the exclude hides everything under .meta/ — so the primary's
    // status must contain exactly one untracked path. A tolerant
    // "everything else is .meta/" assertion would pass vacuously; the
    // exact match is what proves the isolation.
    expect(ownStatus.untracked).toEqual(["notes.md"]);
  });
});
