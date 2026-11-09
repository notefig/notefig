/**
 * The remote operations against system `git http-backend` (as a CGI behind
 * a tiny Node server that demands Basic auth), through the same
 * `GitHttpClient` port and credential reference desktop uses.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withBasicAuth } from "./httpClient";
import { IsomorphicGitService } from "./isomorphicGitService";
import {
  GIT_AUTHOR,
  NodeGitStorageHost,
  SYSTEM_GIT_IDENTITY,
  hasSystemGit,
  runGit,
} from "./realGit.test-helpers";
import type { GitHttpClient, GitRemote, GitServiceDeps } from "./types";
import { createGitWorkerApi, createRpcGitService } from "./workerBoundary";

const describeIfGit = hasSystemGit ? describe : describe.skip;

const nodeHttp: GitHttpClient = {
  async request({ url, method, headers, body }) {
    const res = await fetch(url, { method, headers, body });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: new Uint8Array(await res.arrayBuffer()),
    };
  },
};
const http = withBasicAuth(nodeHttp, {
  tester: { username: "tester", password: "secret" },
});
const AUTH = `Basic ${Buffer.from("tester:secret").toString("base64")}`;

/** Serve `root`'s bare repos via `git http-backend`; 401 without AUTH. */
async function listen(
  handle: (
    req: import("node:http").IncomingMessage,
    body: Buffer,
  ) => Promise<[number, Record<string, string>, Buffer]>,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const [status, headers, body] = await handle(req, Buffer.concat(chunks));
    res.writeHead(status, headers).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
  };
}

function httpBackend(root: string) {
  return listen(async (req, body) => {
    if (req.headers.authorization !== AUTH) return [401, {}, Buffer.alloc(0)];
    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: root,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "tester",
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stdin.end(body);
    await new Promise((resolve) => child.on("close", resolve));
    // CGI reply: headers (with an optional `Status:`), a blank line, body.
    const reply = Buffer.concat(out);
    const split = reply.indexOf("\r\n\r\n");
    const head = reply.subarray(0, split).toString();
    const headers = Object.fromEntries(
      head.split("\r\n").map((line) => line.split(/:\s*/, 2)),
    );
    const status = Number(headers.Status?.slice(0, 3) ?? 200);
    return [status, headers, reply.subarray(split + 4)];
  });
}

describeIfGit("remote operations over git http-backend", () => {
  let root: string;
  let bare: string;
  let seed: string;
  let server: Server;
  let remote: GitRemote;
  let seedOid: string;

  const git = (cwd: string, ...args: string[]) => runGit(cwd, args);
  const bareRef = async (ref: string) =>
    (await git(bare, "for-each-ref", "--format=%(objectname)", ref)) || null;

  /** Commit `text` as note.md in the seed worktree and push it to main. */
  async function seedCommit(text: string): Promise<string> {
    writeFileSync(join(seed, "note.md"), text);
    await git(seed, ...SYSTEM_GIT_IDENTITY, "commit", "-qam", text);
    await git(seed, "push", "-qf", bare, "main");
    return git(seed, "rev-parse", "HEAD");
  }

  const serviceAt = (dir: string, deps: GitServiceDeps = { http }) =>
    new IsomorphicGitService(
      new NodeGitStorageHost(dir),
      { repoPath: dir, gitDir: join(dir, ".git") },
      deps,
    );

  async function clone(name: string, deps?: GitServiceDeps) {
    const dir = join(root, name);
    await git(root, "clone", "-q", bare, dir);
    return { dir, service: serviceAt(dir, deps) };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "git-remote-"));
    bare = join(root, "remote.git");
    seed = join(root, "seed");
    await git(root, "init", "-q", "--bare", "-b", "main", bare);
    await git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "note.md"), "one\n");
    await git(seed, "add", ".");
    await git(seed, ...SYSTEM_GIT_IDENTITY, "commit", "-qm", "seed");
    await git(seed, "push", "-q", bare, "main");
    seedOid = await git(seed, "rev-parse", "HEAD");
    const backend = await httpBackend(root);
    server = backend.server;
    remote = { url: `${backend.url}/remote.git`, credential: "tester" };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the remote's refs under the given prefixes", async () => {
    await git(bare, "update-ref", "refs/notefig/presence/a", seedOid);
    await git(bare, "update-ref", "refs/other/x", seedOid);
    const { service } = await clone("a");

    expect(await service.listRemoteRefs(remote, ["refs/notefig/"])).toEqual([
      { ref: "refs/notefig/presence/a", oid: seedOid },
    ]);
    const all = (await service.listRemoteRefs(remote)).map((r) => r.ref);
    expect(all).toEqual(
      expect.arrayContaining(["HEAD", "refs/heads/main", "refs/other/x"]),
    );
  });

  it("fetches a commit ref, a blob ref and a parentless commit ref", async () => {
    const { dir, service } = await clone("a");
    const next = await seedCommit("two\n");
    writeFileSync(join(root, "payload"), "payload\n");
    const blob = await git(bare, "hash-object", "-w", join(root, "payload"));
    await git(bare, "update-ref", "refs/notefig/blob", blob);
    const orphan = await git(
      bare,
      ...SYSTEM_GIT_IDENTITY,
      "commit-tree",
      `${next}^{tree}`,
      "-m",
      "orphan",
    );
    await git(bare, "update-ref", "refs/notefig/orphan", orphan);

    const refs = [
      "refs/heads/main",
      "refs/notefig/blob",
      "refs/notefig/orphan",
      "refs/notefig/none",
    ];
    expect(await service.fetchRefs(remote, refs)).toEqual([
      { ref: "refs/heads/main", oid: next },
      { ref: "refs/notefig/blob", oid: blob },
      { ref: "refs/notefig/orphan", oid: orphan },
      { ref: "refs/notefig/none", oid: null },
    ]);
    expect(await service.readTextFile({ ref: next, filepath: "note.md" })).toBe(
      "two\n",
    );
    expect(await git(dir, "cat-file", "-p", blob)).toBe("payload");
    expect(await git(dir, "cat-file", "-t", orphan)).toBe("commit");
    expect(await git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(next);
  });

  it("creates a ref only if absent, at push time and on the remote", async () => {
    const { service } = await clone("a");
    const create = { ref: "refs/notefig/lease", oid: seedOid, expect: null };

    await service.pushRef(remote, create);
    expect(await bareRef("refs/notefig/lease")).toBe(seedOid);
    await expect(service.pushRef(remote, create)).rejects.toMatchObject({
      code: "RefConflict",
    });

    // The ref appears between the push's advertisement and its POST.
    const racing: GitHttpClient = {
      async request(request) {
        const response = await http.request(request);
        if (request.url.endsWith("service=git-receive-pack")) {
          await git(bare, "update-ref", "refs/notefig/race", seedOid);
        }
        return response;
      },
    };
    const { service: raced } = await clone("b", { http: racing });
    await expect(
      raced.pushRef(remote, {
        ref: "refs/notefig/race",
        oid: seedOid,
        expect: null,
      }),
    ).rejects.toMatchObject({ code: "PushRejected" });
  });

  it("refuses a non-fast-forward push unless forced, and deletes", async () => {
    const { dir, service } = await clone("a");
    const sideways = await git(
      dir,
      ...SYSTEM_GIT_IDENTITY,
      "commit-tree",
      `${seedOid}^{tree}`,
      "-p",
      seedOid,
      "-m",
      "side",
    );
    const main = { ref: "refs/heads/main", oid: sideways };
    await service.pushRef(remote, main); // fast-forward from seedOid
    expect(await bareRef("refs/heads/main")).toBe(sideways);
    const ahead = await seedCommit("two\n"); // not a descendant of sideways

    await expect(service.pushRef(remote, main)).rejects.toMatchObject({
      code: "NotFastForward",
    });
    expect(await bareRef("refs/heads/main")).toBe(ahead);

    await service.pushRef(remote, { ...main, force: true });
    expect(await bareRef("refs/heads/main")).toBe(sideways);

    await git(bare, "update-ref", "refs/notefig/wip/a", seedOid);
    await service.pushRef(remote, { ref: "refs/notefig/wip/a", delete: true });
    expect(await bareRef("refs/notefig/wip/a")).toBeNull();
  });

  it("merges with the injected driver, and stops on a conflict without one", async () => {
    const { dir, service } = await clone("a");
    const commit = async (text: string) => {
      writeFileSync(join(dir, "note.md"), text);
      await git(dir, ...SYSTEM_GIT_IDENTITY, "commit", "-qam", text);
    };
    await git(dir, "checkout", "-qb", "theirs");
    await commit("theirs\n");
    await git(dir, "checkout", "-q", "main");
    await commit("ours\n");
    const input = { theirs: "theirs", author: GIT_AUTHOR };

    await expect(service.merge(input)).rejects.toMatchObject({
      code: "MergeRequired",
    });

    const driven = serviceAt(dir, {
      mergeDriver: ({ contents: [, ours, theirs] }) => ({
        cleanMerge: true,
        mergedText: ours + theirs,
      }),
    });
    const result = await driven.merge(input);
    expect(result.mergeCommit).toBe(true);
    expect(
      await driven.readTextFile({ ref: result.oid!, filepath: "note.md" }),
    ).toBe("ours\ntheirs\n");
  });

  it("maps HTTP statuses and no response to GitError codes", async () => {
    const { service } = await clone("a");
    await expect(
      service.listRemoteRefs({ url: remote.url }),
    ).rejects.toMatchObject({ code: "AuthRequired" });
    await expect(
      service.listRemoteRefs({
        ...remote,
        url: remote.url.replace("remote.git", "missing.git"),
      }),
    ).rejects.toMatchObject({ code: "RepoNotFound" });

    let status = 0;
    const fake = await listen(async () => [status, {}, Buffer.from("nope")]);
    try {
      for (const [code, expected] of [
        [403, "AuthFailed"],
        [429, "Throttled"],
        [500, "RemoteError"],
      ] as const) {
        status = code;
        await expect(
          service.listRemoteRefs({ url: fake.url }),
        ).rejects.toMatchObject({ code: expected });
      }
    } finally {
      fake.server.closeAllConnections();
      await new Promise((resolve) => fake.server.close(resolve));
    }
    await expect(
      service.listRemoteRefs({ url: fake.url }),
    ).rejects.toMatchObject({ code: "Network" });
  });

  it("runs the remote operations through createRpcGitService", async () => {
    const { dir } = await clone("a");
    const api = createGitWorkerApi(() => new NodeGitStorageHost(dir), { http });
    const service = createRpcGitService((method, args) =>
      api.gitCall({ repoPath: dir, gitDir: join(dir, ".git") }, method, args),
    );

    await service.pushRef(remote, {
      ref: "refs/notefig/x",
      oid: seedOid,
      expect: null,
    });
    expect(await service.listRemoteRefs(remote, ["refs/notefig/"])).toEqual([
      { ref: "refs/notefig/x", oid: seedOid },
    ]);
    expect(await service.fetchRefs(remote, ["refs/notefig/x"])).toEqual([
      { ref: "refs/notefig/x", oid: seedOid },
    ]);
    await expect(
      service.pushRef(remote, {
        ref: "refs/notefig/x",
        oid: seedOid,
        expect: null,
      }),
    ).rejects.toMatchObject({ name: "GitError", code: "RefConflict" });
  });
});
