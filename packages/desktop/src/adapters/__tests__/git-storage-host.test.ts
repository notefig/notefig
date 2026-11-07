import { describe, expect, it, vi } from "vitest";
import { createGitStorageHost } from "../git-storage-host";
import type { FileSystemSurface } from "../platform-adapter.interface";

function fsStub() {
  return {
    readBinaryFiles: vi.fn(),
    writeBinaryFiles: vi.fn(),
    moveFile: vi.fn(),
    deleteFiles: vi.fn(),
    getMetadata: vi.fn(),
    readDirectory: vi.fn(),
    createDirectories: vi.fn(),
    deleteDirectories: vi.fn(),
  } satisfies Partial<Record<keyof FileSystemSurface, unknown>>;
}

describe("createGitStorageHost", () => {
  it("refuses a second lock of the same name, and frees it on unlock", async () => {
    const host = createGitStorageHost(fsStub() as never);

    await host.lock("index");
    await expect(host.lock("index")).rejects.toThrow(/already held/);
    await host.unlock("index");
    await expect(host.lock("index")).resolves.toBeUndefined();
  });

  it("keeps each repo's host's locks to itself", async () => {
    const userRepo = createGitStorageHost(fsStub() as never);
    const other = createGitStorageHost(fsStub() as never);

    await userRepo.lock("index");
    await expect(other.lock("index")).resolves.toBeUndefined();
  });

  it("reports a missing path as not existing, with one metadata call", async () => {
    const fs = fsStub();
    fs.getMetadata.mockResolvedValue({
      succeeded: [],
      failed: [{ path: "/ws/.git/HEAD", type: "not_found", message: "gone" }],
    });
    const host = createGitStorageHost(fs as never);

    await expect(host.stat("/ws/.git/HEAD")).resolves.toEqual({
      exists: false,
      isFile: false,
      isDir: false,
    });
    expect(fs.getMetadata).toHaveBeenCalledTimes(1);
  });

  it("lists a directory with each child's type from one listing", async () => {
    const fs = fsStub();
    fs.readDirectory.mockResolvedValue({
      ok: true,
      value: [
        { path: "/ws/a.md", type: "file" },
        { path: "/ws/notes", type: "directory" },
      ],
    });
    const host = createGitStorageHost(fs as never);

    await expect(host.readDir("/ws")).resolves.toEqual([
      { name: "a.md", isFile: true, isDir: false, isSymbolicLink: false },
      { name: "notes", isFile: false, isDir: true, isSymbolicLink: false },
    ]);
  });
});
