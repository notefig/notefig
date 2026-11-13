import { describe, expect, it, vi } from "vitest";
import { createGitStorageHost } from "../git-storage-host";
import type { FileSystemSurface } from "../platform-adapter.interface";

/**
 * The git host used to be duplicated inside each adapter, with the lock
 * registry as a per-adapter `Set` — which only worked because exactly one
 * adapter instance exists per app. Extracting it (MET-122) makes that
 * assumption explicit as a module-level map, now keyed by the repo's gitdir
 * (MET-51): two repos share one worktree (the user's `.git` and the history
 * repo's `.notefig/.git`), so keying by workspace made them contend on
 * each other's locks.
 */

function fsStub(): FileSystemSurface {
  return {
    readBinaryFiles: vi.fn(),
    writeBinaryFiles: vi.fn(),
    moveFile: vi.fn(),
    deleteFiles: vi.fn(),
    exists: vi.fn(),
    getMetadata: vi.fn(),
    readDirectory: vi.fn(),
    createDirectories: vi.fn(),
    deleteDirectories: vi.fn(),
  } as unknown as FileSystemSurface;
}

// Distinct per test — the lock map is module-level and deliberately never
// reset, exactly as the long-lived app sees it.
let counter = 0;
const gitDir = () => `/ws-git-lock-${counter++}/.git`;

describe("createGitStorageHost lock registry", () => {
  it("refuses a second lock of the same name on the same repo", async () => {
    const host = createGitStorageHost(fsStub(), gitDir());

    await host.lock("index");

    await expect(host.lock("index")).rejects.toThrow(/already held/);
  });

  it("releases on unlock so the name can be taken again", async () => {
    const host = createGitStorageHost(fsStub(), gitDir());

    await host.lock("index");
    await host.unlock("index");

    await expect(host.lock("index")).resolves.toBeUndefined();
  });

  it("scopes locks per gitdir — the same name in another repo is free", async () => {
    const hostA = createGitStorageHost(fsStub(), gitDir());
    const hostB = createGitStorageHost(fsStub(), gitDir());

    await hostA.lock("index");

    await expect(hostB.lock("index")).resolves.toBeUndefined();
  });

  it("keeps the user repo and the history repo of one worktree independent", async () => {
    // The MET-51 case: both repos sit over the same workspace path, so
    // workspace-keyed locks made a history checkpoint contend with a user
    // save. Gitdir keying must keep them apart.
    const workspace = `/ws-git-lock-${counter++}`;
    const userRepo = createGitStorageHost(fsStub(), `${workspace}/.git`);
    const historyRepo = createGitStorageHost(
      fsStub(),
      `${workspace}/.notefig/.git`,
    );

    await userRepo.lock("index");

    await expect(historyRepo.lock("index")).resolves.toBeUndefined();
    await historyRepo.unlock("index");
    await expect(userRepo.lock("index")).rejects.toThrow(/already held/);
  });

  it("shares locks across hosts for one repo, whatever fs they were built on", async () => {
    // The load-bearing case: two hosts for the same repo must contend. This
    // held before only by accident (one adapter ⇒ one Set); now it is the
    // keying that guarantees it.
    const repo = gitDir();
    const first = createGitStorageHost(fsStub(), repo);
    const second = createGitStorageHost(fsStub(), repo);

    await first.lock("index");

    await expect(second.lock("index")).rejects.toThrow(/already held/);

    await first.unlock("index");
    await expect(second.lock("index")).resolves.toBeUndefined();
  });
});

describe("createGitStorageHost writes", () => {
  const refused = { succeeded: [], failed: [{ path: "", type: "permission_denied", message: "EACCES" }] };
  const pack = "/ws/.git/objects/pack/pack-d3b012557885e2a1e960b7d12798b9f648f05484.pack";

  it("takes an object or pack already there as written: it's named by its content", async () => {
    const fs = fsStub();
    vi.mocked(fs.writeBinaryFiles).mockResolvedValue(refused as never);
    vi.mocked(fs.getMetadata).mockResolvedValue({ succeeded: [{ path: pack }], failed: [] } as never);
    const host = createGitStorageHost(fs, gitDir());

    await expect(host.writeFileAtomic(pack, new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(host.writeFileAtomic("/ws/.git/objects/ab/cdef0123456789abcdef0123456789abcdef01", new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it("still fails any other refused write", async () => {
    const fs = fsStub();
    vi.mocked(fs.writeBinaryFiles).mockResolvedValue(refused as never);
    vi.mocked(fs.getMetadata).mockResolvedValue({ succeeded: [{ path: "x" }], failed: [] } as never);
    const host = createGitStorageHost(fs, gitDir());

    await expect(host.writeFileAtomic("/ws/.git/index", new Uint8Array([1]))).rejects.toThrow("EACCES");
    await expect(host.writeFileAtomic("/ws/.git/objects/pack/pack-xyz.pack", new Uint8Array([1]))).rejects.toThrow("EACCES");
  });
});
