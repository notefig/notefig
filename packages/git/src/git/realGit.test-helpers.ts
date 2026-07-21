/**
 * Shared harness for the real-git interop/concurrency suites (MET-83).
 *
 * These tests exercise `IsomorphicGitService` against a real on-disk repository
 * and cross-check every operation with the system `git` binary. This module
 * holds the pieces both suites need — a node-fs `GitStorageHost`, spawners for
 * the `git` binary, and hermetic commit helpers — so neither is duplicated.
 *
 * Not a test file on purpose: jest's `testMatch` skips it (no suite runs here),
 * and it is kept out of the package build via a dedicated `test-helpers` exclude
 * in tsconfig alongside the test-file exclude.
 */
import {
  chmod,
  lstat,
  mkdir,
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
import { dirname, resolve } from "node:path";

import type {
  GitHostDirEntry,
  GitHostLStatResult,
  GitHostStatResult,
  GitStorageHost,
} from "./types";

/** A `GitStorageHost` backed directly by the real filesystem via `node:fs`. */
export class NodeGitStorageHost implements GitStorageHost {
  private locks = new Set<string>();
  private writeSeq = 0;

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
    // Write-temp-then-rename, mirroring production's Rust `fs_ops::atomic_write`.
    // isomorphic-git funnels *every* write (refs, index, loose objects) through
    // writeFileAtomic and relies on it being atomic — a plain writeFile lets a
    // concurrent reader (e.g. the system `git` binary) observe a torn file, which
    // the production host never produces. Same-directory rename is atomic on POSIX.
    const tempPath = `${absolutePath}.tmp-${process.pid}-${(this.writeSeq += 1)}`;
    await writeFile(tempPath, Uint8Array.from(data));
    await rename(tempPath, absolutePath);
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

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnGit(repoPath: string, args: string[]): Promise<GitRunResult> {
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
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Run system `git`, rejecting on a non-zero exit; resolves with trimmed stdout. */
export async function runGit(
  repoPath: string,
  args: string[],
): Promise<string> {
  const result = await spawnGit(repoPath, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Run system `git`, never rejecting on a non-zero exit — inspect `code` yourself. */
export function runGitAllowFail(
  repoPath: string,
  args: string[],
): Promise<GitRunResult> {
  return spawnGit(repoPath, args);
}

/** Hermetic identity so `git commit` never depends on the host's global config. */
export const SYSTEM_GIT_IDENTITY = [
  "-c",
  "user.name=System Tester",
  "-c",
  "user.email=system@test.local",
];

/** Commit already-staged changes through the system `git` binary. */
export function commitViaGit(
  repoPath: string,
  message: string,
): Promise<string> {
  return runGit(repoPath, [...SYSTEM_GIT_IDENTITY, "commit", "-m", message]);
}

export const GIT_AUTHOR = { name: "Metrists", email: "dev@metrists.app" };

export const hasSystemGit =
  spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Force isomorphic-git onto its pako-based (de)compression fallback for the
 * duration of a suite by hiding the global `CompressionStream`/`DecompressionStream`.
 * Returns a restore function to call in `afterAll`.
 */
export function stubCompressionStreams(): () => void {
  const originalCompression = globalThis.CompressionStream;
  const originalDecompression = globalThis.DecompressionStream;
  (
    globalThis as { CompressionStream?: typeof CompressionStream }
  ).CompressionStream = undefined;
  (
    globalThis as { DecompressionStream?: typeof DecompressionStream }
  ).DecompressionStream = undefined;

  return () => {
    (
      globalThis as { CompressionStream?: typeof CompressionStream }
    ).CompressionStream = originalCompression;
    (
      globalThis as { DecompressionStream?: typeof DecompressionStream }
    ).DecompressionStream = originalDecompression;
  };
}
