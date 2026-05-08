import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { IsomorphicGitService } from "./isomorphicGitService";
import type {
  GitHostDirEntry,
  GitHostLStatResult,
  GitHostStatResult,
  GitStorageHost,
} from "./types";

class NodeGitStorageHost implements GitStorageHost {
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

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: repoPath });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }

      reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

const hasSystemGit =
  spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const describeRealGit = hasSystemGit ? describe : describe.skip;

describeRealGit("[real-git] IsomorphicGitService interoperability", () => {
  let repoDir: string;
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
});
