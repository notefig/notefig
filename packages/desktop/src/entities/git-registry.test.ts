import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHost = {
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  renameAtomic: vi.fn(),
  deleteFile: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  readDir: vi.fn(),
  createDir: vi.fn(),
  removeDir: vi.fn(),
  readLink: vi.fn(),
  createSymlink: vi.fn(),
  chmod: vi.fn(),
  lock: vi.fn(),
  unlock: vi.fn(),
};

const initMock = vi.fn();
const isomorphicGitServiceCtor = vi.fn().mockImplementation(() => ({
  init: initMock,
}));

const fsMock = { exists: vi.fn() };
const createGitStorageHostMock = vi.fn(() => mockHost);

vi.mock("@notefig/git", () => ({
  IsomorphicGitService: isomorphicGitServiceCtor,
}));

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: fsMock,
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

// The git host moved above the adapter (MET-122); the registry's contract is
// still "one host per normalized workspace", now asserted on the factory.
vi.mock("@/adapters/git-storage-host", () => ({
  createGitStorageHost: createGitStorageHostMock,
}));

const ensureExcludeLinesMock = vi.fn();
vi.mock("@/utils/git-exclude", () => ({
  ensureExcludeLines: ensureExcludeLinesMock,
}));

describe("git service registry (entities/git)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initMock.mockResolvedValue(undefined);
  });

  it("returns singleton git service per normalized workspace", async () => {
    const store = await import("./git");
    store.clearWorkspaceGitServices();

    const first = store.getOrCreateWorkspaceGitService("/workspace/");
    const second = store.getOrCreateWorkspaceGitService("/workspace");

    expect(first).toBe(second);
    expect(createGitStorageHostMock).toHaveBeenCalledTimes(1);
    expect(createGitStorageHostMock).toHaveBeenCalledWith(
      fsMock,
      "/workspace/.git",
    );
  });

  it("initializes repository once per in-flight workspace", async () => {
    const store = await import("./git");
    store.clearWorkspaceGitServices();

    await Promise.all([
      store.ensureWorkspaceGitInitialized("/workspace"),
      store.ensureWorkspaceGitInitialized("/workspace"),
    ]);

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith({
      repoPath: "/workspace",
      defaultBranch: "main",
    });
    expect(ensureExcludeLinesMock).toHaveBeenCalledWith("/workspace/.git", [
      ".metrists/",
    ]);
  });

  it("re-runs init on later ensure calls", async () => {
    const store = await import("./git");
    store.clearWorkspaceGitServices();

    await store.ensureWorkspaceGitInitialized("/workspace");
    await store.ensureWorkspaceGitInitialized("/workspace");

    expect(initMock).toHaveBeenCalledTimes(2);
  });

  it("disposes a workspace service entry", async () => {
    const store = await import("./git");
    store.clearWorkspaceGitServices();

    const first = store.getOrCreateWorkspaceGitService("/workspace");
    store.disposeWorkspaceGitService("/workspace");
    const second = store.getOrCreateWorkspaceGitService("/workspace");

    expect(first).not.toBe(second);
    expect(createGitStorageHostMock).toHaveBeenCalledTimes(2);
  });
});
