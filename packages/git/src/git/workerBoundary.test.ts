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
import { GitError, type GitRepoRef } from "./types";
import { GIT_AUTHOR, NodeGitStorageHost } from "./realGit.test-helpers";

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
    const result = await api.gitCall(
      repo,
      "notAMethod" as never,
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: "git", code: "InvalidInput" });
    }
  });
});
