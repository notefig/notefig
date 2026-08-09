import { describe, expect, it, vi } from "vitest";
import { createGitStorageHost } from "../git-storage-host";
import type { FileSystemSurface } from "../platform-adapter.interface";

/**
 * The git host used to be duplicated inside each adapter, with the lock
 * registry as a per-adapter `Set` — which only worked because exactly one
 * adapter instance exists per app. Extracting it (MET-122) makes that
 * assumption explicit as a module-level map keyed by workspace, so the
 * invariant is worth asserting directly rather than leaving it implicit.
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
const ws = () => `/ws-git-lock-${counter++}`;

describe("createGitStorageHost lock registry", () => {
  it("refuses a second lock of the same name on the same workspace", async () => {
    const host = createGitStorageHost(fsStub(), ws());

    await host.lock("index");

    await expect(host.lock("index")).rejects.toThrow(/already held/);
  });

  it("releases on unlock so the name can be taken again", async () => {
    const host = createGitStorageHost(fsStub(), ws());

    await host.lock("index");
    await host.unlock("index");

    await expect(host.lock("index")).resolves.toBeUndefined();
  });

  it("scopes locks per workspace — the same name in another workspace is free", async () => {
    const hostA = createGitStorageHost(fsStub(), ws());
    const hostB = createGitStorageHost(fsStub(), ws());

    await hostA.lock("index");

    await expect(hostB.lock("index")).resolves.toBeUndefined();
  });

  it("shares locks across hosts for one workspace, whatever fs they were built on", async () => {
    // The load-bearing case: two hosts for the same repo must contend. This
    // held before only by accident (one adapter ⇒ one Set); now it is the
    // keying that guarantees it.
    const workspace = ws();
    const first = createGitStorageHost(fsStub(), workspace);
    const second = createGitStorageHost(fsStub(), workspace);

    await first.lock("index");

    await expect(second.lock("index")).rejects.toThrow(/already held/);

    await first.unlock("index");
    await expect(second.lock("index")).resolves.toBeUndefined();
  });
});
