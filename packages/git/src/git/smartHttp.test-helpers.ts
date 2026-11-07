/**
 * Harness for the smart-HTTP suites: a tiny Node HTTP server that runs
 * system `git http-backend` as a CGI per request (system git in TESTS
 * only), a fake server for status mapping, and a Node http port.
 *
 * Not a test file: excluded from the build like realGit.test-helpers.ts.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import git from "isomorphic-git";

import { IsomorphicGitService } from "./isomorphicGitService";
import {
  NodeGitStorageHost,
  SYSTEM_GIT_IDENTITY,
  runGit,
} from "./realGit.test-helpers";
import { createFetchHttpClient } from "./smartHttp/httpPorts";
import { createIsomorphicGitFs } from "./isomorphicGitFs";
import type { GitHttpClient, GitRepoRef, GitServiceDeps } from "./types";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Buffer;
  authorization?: string;
}

export interface TestServer {
  /** Base URL; a repo at `<root>/<name>.git` is `${url}/<name>.git`. */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function listen(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ) => void | Promise<void>,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body,
      authorization: req.headers.authorization,
    });
    await handler(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function writeCgiResponse(res: ServerResponse, output: Buffer): void {
  let split = output.indexOf("\r\n\r\n");
  let sepLength = 4;
  if (split < 0) {
    split = output.indexOf("\n\n");
    sepLength = 2;
  }
  const head = output.subarray(0, split).toString("utf8");
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else if (name) res.setHeader(name, value);
  }
  res.statusCode = status;
  res.end(output.subarray(split + sepLength));
}

/**
 * Serve every bare repo under `projectRoot` through `git http-backend`.
 * With `basicAuth`, requests without that exact Basic credential get 401.
 */
export function startGitHttpBackend(
  projectRoot: string,
  options: { basicAuth?: { username: string; password: string } } = {},
): Promise<TestServer> {
  const expected = options.basicAuth
    ? `Basic ${Buffer.from(`${options.basicAuth.username}:${options.basicAuth.password}`).toString("base64")}`
    : undefined;
  return listen((req, res, body) => {
    if (expected && req.headers.authorization !== expected) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="test"');
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: projectRoot,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "tester",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on("close", () => writeCgiResponse(res, Buffer.concat(out)));
    child.stdin.end(body);
  });
}

/** A server that answers every request with `status`, or never (`"hang"`). */
export function startFakeServer(status: number | "hang"): Promise<TestServer> {
  return listen((_req, res) => {
    if (status === "hang") return;
    res.statusCode = status;
    res.end("nope");
  });
}

/** Node's fetch (keep-alive) as the http port, with an optional timeout. */
export function nodeHttpClient(timeoutMs?: number): GitHttpClient {
  return createFetchHttpClient((url, init) =>
    fetch(url, {
      ...init,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    }),
  );
}

export interface RemoteFixture {
  root: string;
  bare: string;
  server: TestServer;
  /** URL of the bare repo. */
  url: string;
  cleanup(): Promise<void>;
}

/** A bare repo with `note.md` on `main`, served over HTTP. */
export async function createRemoteFixture(
  options: { basicAuth?: { username: string; password: string } } = {},
): Promise<RemoteFixture> {
  const root = mkdtempSync(join(tmpdir(), "git-smart-http-"));
  const bare = join(root, "remote.git");
  await runGit(root, ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = join(root, "seed");
  await runGit(root, ["init", "-q", "-b", "main", seed]);
  await writeFileText(
    join(seed, "note.md"),
    "line one\nline two\nline three\n",
  );
  await runGit(seed, ["add", "."]);
  await runGit(seed, [...SYSTEM_GIT_IDENTITY, "commit", "-q", "-m", "seed"]);
  await runGit(seed, ["push", "-q", bare, "main"]);
  const server = await startGitHttpBackend(root, options);
  return {
    root,
    bare,
    server,
    url: `${server.url}/remote.git`,
    cleanup: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function writeFileText(path: string, text: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export interface LocalClone {
  repo: GitRepoRef;
  service: IsomorphicGitService;
  /** Commit `files` (path → text) on the current branch via isomorphic-git. */
  commitFiles(files: Record<string, string>, message: string): Promise<string>;
}

/** A system-git clone of the fixture's bare repo, wrapped in a service. */
export async function cloneFixture(
  fixture: RemoteFixture,
  name: string,
  deps: GitServiceDeps = { http: nodeHttpClient() },
): Promise<LocalClone> {
  const repoPath = join(fixture.root, name);
  await runGit(fixture.root, ["clone", "-q", fixture.bare, repoPath]);
  const repo = { repoPath, gitDir: join(repoPath, ".git") };
  const host = new NodeGitStorageHost(repoPath);
  const service = new IsomorphicGitService(host, repo, deps);
  const fs = createIsomorphicGitFs(host);
  return {
    repo,
    service,
    async commitFiles(files, message) {
      for (const [path, text] of Object.entries(files)) {
        await writeFileText(join(repoPath, path), text);
        await git.add({
          fs,
          dir: repoPath,
          gitdir: repo.gitDir,
          filepath: path,
        });
      }
      return git.commit({
        fs,
        dir: repoPath,
        gitdir: repo.gitDir,
        message,
        author: { name: "Tester", email: "tester@test.local" },
      });
    },
  };
}

/** The bare repo's value for `ref`, or null. */
export async function bareRef(
  fixture: RemoteFixture,
  ref: string,
): Promise<string | null> {
  const out = await runGit(fixture.bare, [
    "for-each-ref",
    "--format=%(objectname)",
    ref,
  ]);
  return out || null;
}
