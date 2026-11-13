/**
 * Sync over a real git remote, in-process: a bare repo served by system
 * `git http-backend` (`@notefig/git/testing`; system git in tests only),
 * workspaces that are real clones in a temp dir, a platform fs over
 * Node's fs, and a `gitWorker` whose services run in-process — the same
 * `@notefig/git` code the worker runs, minus the postMessage hop.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, promises as fsp, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineModule } from "@notefig/core";
import { IsomorphicGitService, type GitHttpClient, type GitHttpResponse } from "@notefig/git";
import { httpBackend } from "@notefig/git/testing";
import type {
  BatchResult,
  FileSystemError,
  FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { createGitStorageHost } from "@/adapters/git-storage-host";
import type { GitWorker } from "@/modules/git-worker";

const IDENTITY = ["-c", "user.name=Plain Git", "-c", "user.email=plain@test.local", "-c", "commit.gpgsign=false"];

/** Run system git; resolves with stdout. */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...IDENTITY, ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString("utf8").trim())
        : reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(err)}`)),
    );
  });
}

/** How the remote behaves right now. */
export type RemoteMode = "ok" | "offline" | "unauthorized" | "hang-push";

export interface TestRemote {
  root: string;
  bare: string;
  url: string;
  http: GitHttpClient;
  /** Requests made: `METHOD service`. */
  requests: string[];
  mode: RemoteMode;
  tip(branch?: string): Promise<string | null>;
  /** Clone into `<root>/<name>` with system git, as user `name`. */
  clone(name: string): Promise<string>;
  /** Commit files in a plain-git clone and push them. */
  pushFromPlainGit(clone: string, files: Record<string, string>, message: string): Promise<string>;
  cleanup(): void;
}

const empty = (status: number): GitHttpResponse => ({ status, headers: {}, body: new Uint8Array(0) });

/** A bare repo with `note.md` on `main`, at `https://127.0.0.1/remote.git`. */
export async function createTestRemote(
  seed: Record<string, string> = { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n" },
): Promise<TestRemote> {
  const root = mkdtempSync(join(tmpdir(), "notefig-sync-"));
  const bare = join(root, "remote.git");
  await runGit(root, ["init", "-q", "--bare", "-b", "main", bare]);
  await runGit(bare, ["config", "http.receivepack", "true"]);
  const seedDir = join(root, "seed");
  await runGit(root, ["init", "-q", "-b", "main", seedDir]);
  for (const [path, text] of Object.entries(seed)) {
    await fsp.mkdir(dirname(join(seedDir, path)), { recursive: true });
    await fsp.writeFile(join(seedDir, path), text);
  }
  await runGit(seedDir, ["add", "."]);
  await runGit(seedDir, ["commit", "-q", "-m", "seed"]);
  await runGit(seedDir, ["push", "-q", bare, "main"]);

  const backend = httpBackend(root);
  const requests: string[] = [];
  const remote: TestRemote = {
    root,
    bare,
    url: "https://127.0.0.1/remote.git",
    requests,
    mode: "ok",
    http: {
      async request(request) {
        const service = /service=([a-z-]+)|\/(git-[a-z-]+)$/.exec(request.url);
        requests.push(`${request.method} ${service?.[1] ?? service?.[2] ?? request.url}`);
        if (remote.mode === "offline") throw new Error("connection refused");
        if (remote.mode === "unauthorized") return empty(401);
        const response = await backend.request(request);
        if (remote.mode === "hang-push" && request.url.endsWith("/git-receive-pack")) {
          throw new Error("timed out");
        }
        return response;
      },
    },
    async tip(branch = "main") {
      return runGit(bare, ["rev-parse", `refs/heads/${branch}`]).catch(() => null);
    },
    async clone(name) {
      const path = join(root, name);
      await runGit(root, ["clone", "-q", bare, path]);
      await runGit(path, ["config", "user.name", `User ${name}`]);
      await runGit(path, ["config", "user.email", `${name}@test.local`]);
      // What a real clone has: the remote's https URL.
      await runGit(path, ["remote", "set-url", "origin", remote.url]);
      return path;
    },
    async pushFromPlainGit(clone, files, message) {
      await runGit(clone, ["pull", "-q", "--ff-only", bare, "main"]);
      for (const [path, text] of Object.entries(files)) {
        await fsp.mkdir(dirname(join(clone, path)), { recursive: true });
        await fsp.writeFile(join(clone, path), text);
      }
      await runGit(clone, ["add", "-A"]);
      await runGit(clone, ["commit", "-q", "-m", message]);
      await runGit(clone, ["push", "-q", bare, "HEAD:main"]);
      return runGit(clone, ["rev-parse", "HEAD"]);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return remote;
}

// --- A platform fs over Node --------------------------------------------------

function failure(path: string, error: unknown): FileSystemError {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    path,
    type: code === "ENOENT" ? "not_found" : "unknown",
    message: error instanceof Error ? error.message : String(error),
  } as FileSystemError;
}

async function batch<T>(
  paths: string[],
  run: (path: string) => Promise<T>,
): Promise<BatchResult<T>> {
  const result: BatchResult<T> = { succeeded: [], failed: [] };
  for (const path of paths) {
    try {
      result.succeeded.push(await run(path));
    } catch (error) {
      result.failed.push(failure(path, error));
    }
  }
  return result;
}

interface ListOptions {
  recursive?: boolean;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  ignore?: { directories: string[] };
}

/** A listing like the adapters': `.git` and ignored folders are skipped. */
async function listDirectory(
  path: string,
  options: ListOptions,
): Promise<{ path: string; type: "file" | "directory" }[]> {
  const entries: Dirent[] = await fsp.readdir(path, { withFileTypes: true });
  const skipped = new Set([".git", ...(options.ignore?.directories ?? [])]);
  const out: { path: string; type: "file" | "directory" }[] = [];
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (!entry.isDirectory()) {
      if (options.includeFiles !== false) out.push({ path: full, type: "file" });
      continue;
    }
    if (options.includeDirectories !== false) out.push({ path: full, type: "directory" });
    if (options.recursive && !skipped.has(entry.name.toLowerCase())) {
      out.push(...(await listDirectory(full, options)));
    }
  }
  return out;
}

/** The fs surface sync, files and documents use, on the real disk. */
export function nodeFs(): FileSystemSurface {
  const write = async (path: string, data: string | Uint8Array) => {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, data);
    return path;
  };
  const fs: Partial<FileSystemSurface> = {
    readFiles: (paths) =>
      batch(paths, async (path) => ({ path, content: await fsp.readFile(path, "utf8") })),
    readBinaryFiles: (paths) =>
      batch(paths, async (path) => ({
        path,
        data: new Uint8Array(await fsp.readFile(path)),
      })),
    writeFiles: (files) =>
      batch(
        files.map((file) => file.path),
        (path) => write(path, files.find((file) => file.path === path)!.content),
      ),
    writeBinaryFiles: (files) =>
      batch(
        files.map((file) => file.path),
        (path) => write(path, files.find((file) => file.path === path)!.data),
      ),
    deleteFiles: (paths) =>
      batch(paths, async (path) => {
        await fsp.rm(path, { force: true });
        return path;
      }),
    createDirectories: (paths) =>
      batch(paths, async (path) => {
        await fsp.mkdir(path, { recursive: true });
        return path;
      }),
    deleteDirectories: (paths, options) =>
      batch(paths, async (path) => {
        if (options?.recursive) await fsp.rm(path, { recursive: true, force: true });
        else await fsp.rmdir(path);
        return path;
      }),
    async moveFile(from, to) {
      try {
        await fsp.mkdir(dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: failure(from, error) };
      }
    },
    getMetadata: (paths) =>
      batch(paths, async (path) => {
        const stat = await fsp.stat(path);
        return {
          path,
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.size,
          modifiedAt: stat.mtime,
          createdAt: stat.birthtime,
        };
      }) as never,
    exists: async (paths) =>
      Promise.all(
        paths.map(async (path) => {
          try {
            const stat = await fsp.stat(path);
            return { path, exists: true, type: stat.isDirectory() ? "directory" : "file" };
          } catch {
            return { path, exists: false };
          }
        }),
      ) as never,
    async readDirectory(path, options) {
      try {
        return { ok: true, value: await listDirectory(path, options ?? {}) } as never;
      } catch (error) {
        return { ok: false, error: failure(path, error) };
      }
    },
    onFsEvent: () => () => {},
    startWatchingMetadata: async () => {},
    startWatchingContent: async () => {},
    stopWatching: async () => {},
  };
  return fs as FileSystemSurface;
}

// --- The git worker --------------------------------------------------------

/** A `gitWorker` whose services run in-process over `fs` and `http`. */
export function inProcessGitWorker(fs: FileSystemSurface, http: GitHttpClient) {
  const worker: GitWorker = {
    create: (repo) => new IsomorphicGitService(createGitStorageHost(fs, repo.gitDir), repo, { http }),
    dispose: () => {},
  };
  return defineModule({ name: "gitWorker", register: () => worker });
}
