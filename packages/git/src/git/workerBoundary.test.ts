/**
 * The worker boundary, exercised fully in-process: `createRpcGitService`
 * talking to `createGitWorkerApi` over a direct call (the same wiring the
 * desktop app runs over a Web Worker RPC), against a real repo on disk via
 * the node-fs storage host. Covers the data path, error serialization/
 * rehydration (GitError natively, app errors via the revive hook), and the
 * per-gitdir registry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createGitWorkerApi,
  createRpcGitService,
  serializeGitBoundaryError,
  type GitBoundaryError,
} from "./workerBoundary";
import { IsomorphicGitService } from "./isomorphicGitService";
import {
  GitError,
  ZERO_OID,
  type GitHttpClient,
  type GitHttpRequest,
  type GitRepoRef,
} from "./types";
import { GIT_AUTHOR, NodeGitStorageHost } from "./realGit.test-helpers";
import { FLUSH_PKT, concatBytes, encodePktLine } from "./smartHttp/pktLine";

function makeTempRepo(): GitRepoRef {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-boundary-"));
  return { repoPath, gitDir: path.join(repoPath, ".git") };
}

describe("git worker boundary", () => {
  let repo: GitRepoRef;

  beforeEach(() => {
    repo = makeTempRepo();
  });

  afterEach(() => {
    fs.rmSync(repo.repoPath, { recursive: true, force: true });
  });

  it("round-trips a real init → add → commit → status/log through gitCall", async () => {
    const api = createGitWorkerApi(() => new NodeGitStorageHost(repo.repoPath));
    const service = createRpcGitService((method, args) =>
      api.gitCall(repo, method, args),
    );

    await service.init({ defaultBranch: "main" });
    fs.writeFileSync(path.join(repo.repoPath, "note.md"), "hello\n");

    const oid = await service.addAllAndCommit({
      message: "checkpoint",
      author: GIT_AUTHOR,
    });
    expect(typeof oid).toBe("string");

    const status = await service.status();
    expect(status.currentBranch).toBe("main");
    expect(status.staged).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);

    const log = await service.log({ depth: 10 });
    expect(log).toHaveLength(1);
    expect(log[0].commit.message.trim()).toBe("checkpoint");
  });

  it("rehydrates GitError with its code across the boundary", async () => {
    const api = createGitWorkerApi(() => new NodeGitStorageHost(repo.repoPath));
    const service = createRpcGitService((method, args) =>
      api.gitCall(repo, method, args),
    );

    // No init: status on an empty directory must surface RepoNotFound.
    await expect(service.status()).rejects.toMatchObject({
      name: "GitError",
      code: "RepoNotFound",
    });
    await expect(service.status()).rejects.toBeInstanceOf(GitError);
  });

  it("serializes FsError-shaped app errors structurally and revives via hook", async () => {
    class FakeFsError extends Error {
      readonly type = "permission_denied";
      readonly path = "/ws/notes.md";
      constructor() {
        super("denied");
        this.name = "FsError";
      }
    }
    const serialized = serializeGitBoundaryError(new FakeFsError());
    expect(serialized).toEqual({
      kind: "fs",
      type: "permission_denied",
      path: "/ws/notes.md",
      message: "denied",
    });

    const revived: Error[] = [];
    const service = createRpcGitService(
      async () => ({ ok: false, error: serialized }),
      (error: GitBoundaryError) => {
        const err = new Error(`revived:${error.kind}`);
        revived.push(err);
        return err;
      },
    );
    await expect(service.status()).rejects.toThrow("revived:fs");
    expect(revived).toHaveLength(1);
  });

  it("keeps one service per gitdir and drops it on disposeRepo", async () => {
    let hostsCreated = 0;
    const api = createGitWorkerApi(() => {
      hostsCreated += 1;
      return new NodeGitStorageHost(repo.repoPath);
    });

    await api.gitCall(repo, "init", [{ defaultBranch: "main" }]);
    await api.gitCall(repo, "status", []);
    expect(hostsCreated).toBe(1);

    await api.disposeRepo(repo.gitDir);
    await api.gitCall(repo, "status", []);
    expect(hostsCreated).toBe(2);
  });

  it("rejects unknown methods as InvalidInput without throwing across", async () => {
    const api = createGitWorkerApi(() => new NodeGitStorageHost(repo.repoPath));
    const result = await api.gitCall(repo, "notAMethod" as never, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: "git", code: "InvalidInput" });
    }
  });

  it("exposes every GitService method over the RPC", () => {
    const service = createRpcGitService(async () => ({
      ok: true,
      value: null,
    }));
    const methods = Object.getOwnPropertyNames(
      IsomorphicGitService.prototype,
    ).filter(
      (name) =>
        name !== "constructor" &&
        !name.startsWith("ensure") &&
        typeof (
          IsomorphicGitService.prototype as unknown as Record<string, unknown>
        )[name] === "function",
    );
    const missing = methods.filter(
      (name) =>
        typeof (service as unknown as Record<string, unknown>)[name] !==
        "function",
    );
    // Private helpers aren't part of GitService.
    expect(
      missing.filter(
        (name) =>
          ![
            "fail",
            "httpPort",
            "transport",
            "isomorphicRemote",
            "run",
            "computeRevertChanges",
          ].includes(name),
      ),
    ).toEqual([]);
  });

  it("carries the remote and plumbing methods across as plain data", async () => {
    const requests: GitHttpRequest[] = [];
    const reply = (body: Uint8Array) => ({ status: 200, headers: {}, body });
    let main = "";
    const http: GitHttpClient = {
      async request(request) {
        requests.push(request);
        if (request.url.endsWith("service=git-upload-pack")) {
          return {
            status: 200,
            headers: {
              "Content-Type": "application/x-git-upload-pack-advertisement",
            },
            body: concatBytes([
              encodePktLine("# service=git-upload-pack\n"),
              FLUSH_PKT,
              encodePktLine(`${main} refs/heads/main\0ofs-delta\n`),
              FLUSH_PKT,
            ]),
          };
        }
        if (request.method === "GET") {
          return reply(
            concatBytes([
              encodePktLine(
                `${ZERO_OID} capabilities^{}\0report-status atomic delete-refs\n`,
              ),
              FLUSH_PKT,
            ]),
          );
        }
        return reply(
          concatBytes([
            encodePktLine("unpack ok\n"),
            encodePktLine("ok refs/notefig/v1/presence/d\n"),
            FLUSH_PKT,
          ]),
        );
      },
    };
    const api = createGitWorkerApi(
      () => new NodeGitStorageHost(repo.repoPath),
      () => ({ http }),
    );
    const service = createRpcGitService((method, args) =>
      api.gitCall(repo, method, args),
    );
    const remote = {
      url: "https://example.test/o/r.git",
      credential: "example.test/o/r",
    };

    await service.init({ defaultBranch: "main" });
    fs.writeFileSync(path.join(repo.repoPath, "note.md"), "hello\n");
    main = (await service.addAllAndCommit({
      message: "c",
      author: GIT_AUTHOR,
    }))!;

    expect(await service.listRemoteRefs(remote, ["refs/heads/main"])).toEqual([
      { ref: "refs/heads/main", oid: main },
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://example.test/o/r.git/info/refs?service=git-upload-pack",
        credential: "example.test/o/r",
        headers: { "User-Agent": "git/notefig" },
      }),
    ]);
    // Already local: resolves without a request.
    expect(
      await service.fetchRefs(remote, [{ ref: "refs/heads/main", oid: main }]),
    ).toEqual({
      refs: [{ ref: "refs/heads/main", oid: main, localRef: undefined }],
      missing: [],
      objectCount: 0,
    });

    const blob = await service.writeBlob(new TextEncoder().encode("presence"));
    expect(new TextDecoder().decode(await service.readBlob(blob))).toBe(
      "presence",
    );
    expect(
      await service.pushRefs(remote, [
        { ref: "refs/notefig/v1/presence/d", old: ZERO_OID, new: blob },
      ]),
    ).toEqual({
      ok: true,
      unpack: "ok",
      refs: [{ ref: "refs/notefig/v1/presence/d", ok: true }],
      messages: [],
    });

    await service.writeRef({ ref: "refs/notefig-local/r", oid: blob });
    expect(await service.readRef("refs/notefig-local/r")).toBe(blob);
    await service.deleteRef("refs/notefig-local/r");
    expect(await service.readRef("refs/notefig-local/r")).toBeNull();
    expect(await service.mergeBase(main, "refs/heads/main")).toBe(main);
    expect(await service.rebaseOnto({ theirs: main })).toEqual({
      status: "up-to-date",
      oid: main,
    });
  });

  it("maps a remote's HTTP status to a GitError code across the boundary", async () => {
    const api = createGitWorkerApi(
      () => new NodeGitStorageHost(repo.repoPath),
      () => ({
        http: {
          request: async () => ({
            status: 429,
            headers: {},
            body: new Uint8Array(),
          }),
        },
      }),
    );
    const service = createRpcGitService((method, args) =>
      api.gitCall(repo, method, args),
    );
    await expect(
      service.listRemoteRefs({ url: "https://example.test/r.git" }, []),
    ).rejects.toMatchObject({ name: "GitError", code: "Throttled" });
  });
});
