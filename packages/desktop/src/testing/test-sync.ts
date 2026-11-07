/**
 * Sync over a real git remote, in-process: a bare repo on disk served by
 * system `git http-backend` (as CGI, no server; system git in tests only),
 * workspaces that are real clones in a temp dir, a platform fs over Node's
 * fs, and a `syncRuntime` whose worker is the real worker API
 * (`createInProcessSyncWorker`) — the same code the sync worker runs, minus
 * the postMessage hop. The engine is the real one, loaded the same lazy way.
 */
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  promises as fsp,
  rmSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineModule, type AnyModule } from "@notefig/core";
import type {
  GitHttpClient,
  GitHttpRequest,
  GitHttpResponse,
} from "@notefig/git";
import type {
  BatchResult,
  FileSystemError,
  FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { createGitStorageHost } from "@/adapters/git-storage-host";
import { createInProcessSyncWorker } from "@/modules/sync/engine/sync-worker-api";
import { loadSyncEngine, type SyncRuntime } from "@/modules/sync/sync-runtime";
import type { SyncWorkerApi } from "@/modules/sync/sync-types";
import type { MarkdownMerge } from "@/modules/sync/merge/merge";

const IDENTITY = [
  "-c",
  "user.name=Plain Git",
  "-c",
  "user.email=plain@test.local",
  "-c",
  "commit.gpgsign=false",
];

/** Run system git; resolves with stdout. */
export function runGit(cwd: string, args: string[], input?: Buffer): Promise<string> {
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
    child.stdin.end(input);
  });
}

// --- The remote ---------------------------------------------------------------

/** How the fake transport behaves right now. */
export type RemoteMode = "ok" | "offline" | "unauthorized" | "throttled" | "hang-push";

export interface TestRemote {
  root: string;
  bare: string;
  url: string;
  /** The credential reference requests must carry (`127.0.0.1/remote`). */
  credential: string;
  http: GitHttpClient;
  /** Requests made, for rate checks: `METHOD service`. */
  requests: string[];
  mode: RemoteMode;
  /** Runs before each request reaches the backend (`METHOD service`):
   *  lets a test land someone else's push mid-cycle. */
  onRequest: ((label: string) => Promise<void>) | null;
  /** The branch tip on the remote. */
  tip(branch?: string): Promise<string | null>;
  /** Clone into `<root>/<name>` with system git. */
  clone(name: string): Promise<string>;
  /** Commit files in a plain-git clone and push them. */
  pushFromPlainGit(clone: string, files: Record<string, string>, message: string): Promise<string>;
  cleanup(): void;
}

function cgiResponse(output: Buffer): GitHttpResponse {
  let split = output.indexOf("\r\n\r\n");
  let sep = 4;
  if (split < 0) {
    split = output.indexOf("\n\n");
    sep = 2;
  }
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, split).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else if (name) headers[name.toLowerCase()] = value;
  }
  return { status, headers, body: new Uint8Array(output.subarray(split + sep)) };
}

function httpBackend(root: string, request: GitHttpRequest): Promise<GitHttpResponse> {
  const url = new URL(request.url);
  const body = Buffer.from(request.body ?? new Uint8Array(0));
  const header = (name: string) =>
    Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: root,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: header("content-type"),
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: header("git-protocol"),
        REMOTE_USER: "tester",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => resolve(cgiResponse(Buffer.concat(out))));
    child.stdin.end(body);
  });
}

const empty = (status: number): GitHttpResponse => ({
  status,
  headers: {},
  body: new Uint8Array(0),
});

/** A bare repo with `note.md` on `main`, reachable over a fake HTTPS URL. */
export async function createTestRemote(
  seed: Record<string, string> = { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n" },
): Promise<TestRemote> {
  const root = mkdtempSync(join(tmpdir(), "notefig-sync-"));
  const bare = join(root, "remote.git");
  await runGit(root, ["init", "-q", "--bare", "-b", "main", bare]);
  // Sync pushes a branch the clones check out; let it.
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

  const credential = "127.0.0.1/remote";
  const requests: string[] = [];
  const remote: TestRemote = {
    root,
    bare,
    url: "https://127.0.0.1/remote.git",
    credential,
    requests,
    mode: "ok",
    onRequest: null,
    http: {
      async request(request) {
        const service = /service=([a-z-]+)|\/(git-[a-z-]+)$/.exec(request.url);
        const label = `${request.method} ${service?.[1] ?? service?.[2] ?? request.url}`;
        requests.push(label);
        await remote.onRequest?.(label);
        if (remote.mode === "offline") throw new Error("connection refused");
        if (remote.mode === "throttled") return empty(429);
        // What Rust does: a request without the stored credential gets no
        // Authorization, and the host refuses it.
        if (remote.mode === "unauthorized" || request.credential !== credential) {
          return empty(401);
        }
        if (remote.mode === "hang-push" && request.url.endsWith("/git-receive-pack")) {
          await httpBackend(root, request);
          throw new Error("timed out");
        }
        return httpBackend(root, request);
      },
    },
    async tip(branch = "main") {
      try {
        return await runGit(bare, ["rev-parse", `refs/heads/${branch}`]);
      } catch {
        return null;
      }
    },
    async clone(name) {
      const path = join(root, name);
      await runGit(root, ["clone", "-q", bare, path]);
      await runGit(path, ["config", "user.name", `User ${name}`]);
      await runGit(path, ["config", "user.email", `${name}@test.local`]);
      return path;
    },
    async pushFromPlainGit(clone, files, message) {
      await runGit(clone, ["pull", "-q", "--ff-only"]);
      for (const [path, text] of Object.entries(files)) {
        await fsp.mkdir(dirname(join(clone, path)), { recursive: true });
        await fsp.writeFile(join(clone, path), text);
      }
      await runGit(clone, ["add", "-A"]);
      await runGit(clone, ["commit", "-q", "-m", message]);
      await runGit(clone, ["push", "-q", "origin", "HEAD"]);
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

// --- The runtime --------------------------------------------------------------

export interface InProcessRuntime {
  module: AnyModule;
  /** Workers started, and how many were terminated. */
  launched: number;
  terminated: number;
  /** Worker calls by method, in order. */
  calls: string[];
  /** Times a worker loaded the markdown merge. */
  mergeLoads: number;
}

/** A `syncRuntime` serving the real worker API in-process over `remote`.
 *  `wrapMerge` wraps the worker's markdown merge (to observe or break it). */
export function inProcessSyncRuntime(
  fs: FileSystemSurface,
  remote: Pick<TestRemote, "http">,
  options: { wrapMerge?: (merge: MarkdownMerge) => MarkdownMerge } = {},
): InProcessRuntime {
  const stats: InProcessRuntime = {
    module: null as never,
    launched: 0,
    terminated: 0,
    calls: [],
    mergeLoads: 0,
  };
  const loadMerge = async () => {
    stats.mergeLoads += 1;
    const { createWorkerMerge } = await import("@/modules/sync/merge/worker-merge");
    const merge = createWorkerMerge();
    return options.wrapMerge ? options.wrapMerge(merge) : merge;
  };
  const runtime: SyncRuntime = {
    loadEngine: loadSyncEngine,
    async launchWorker() {
      stats.launched += 1;
      const inner = createInProcessSyncWorker(
        () => createGitStorageHost(fs),
        remote.http,
        fs,
        loadMerge,
      );
      let alive = true;
      const api = Object.fromEntries(
        Object.entries(inner).map(([method, call]) => [
          method,
          (...args: unknown[]) => {
            if (!alive) return Promise.reject(new Error("worker terminated"));
            stats.calls.push(method);
            return (call as (...a: unknown[]) => unknown)(...args);
          },
        ]),
      ) as SyncWorkerApi;
      return {
        api,
        terminate() {
          alive = false;
          stats.terminated += 1;
        },
      };
    },
  };
  stats.module = defineModule({ name: "syncRuntime", register: () => runtime });
  return stats;
}
