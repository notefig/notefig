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
