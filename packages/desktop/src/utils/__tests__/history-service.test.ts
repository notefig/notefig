import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  initMock,
  existsMock,
  moveDirectoryMock,
  fsMock,
  createGitStorageHostMock,
  ensureExcludeLinesMock,
} = vi.hoisted(() => {
  const initMock = vi.fn();
  const existsMock = vi.fn();
  const moveDirectoryMock = vi.fn();
  return {
    initMock,
    existsMock,
    moveDirectoryMock,
    fsMock: { exists: existsMock, moveDirectory: moveDirectoryMock },
    createGitStorageHostMock: vi.fn(() => ({})),
    ensureExcludeLinesMock: vi.fn(),
  };
});

vi.mock("@notefig/git", () => ({
  IsomorphicGitService: vi.fn().mockImplementation(() => ({
    init: initMock,
  })),
}));

vi.mock("@/adapters", () => ({
  platformAdapter: { fs: fsMock },
}));

vi.mock("@/adapters/git-storage-host", () => ({
  createGitStorageHost: createGitStorageHostMock,
}));

vi.mock("@/utils/git-exclude", () => ({
  ensureExcludeLines: ensureExcludeLinesMock,
}));

import {
  clearWorkspaceHistoryServices,
  ensureWorkspaceHistoryInitialized,
  getOrCreateWorkspaceHistoryService,
  historyGitDir,
} from "../history-service";

const WS = "/workspace";
const GIT_DIR = "/workspace/.metrists/.git";
const LEGACY_DIR = "/workspace/.metrists/history";

/** Configure fs.exists to answer per path from a lookup. */
function setExisting(paths: Record<string, boolean>) {
  existsMock.mockImplementation(async (queried: string[]) =>
    queried.map((path) => ({
      path,
      exists: paths[path] ?? false,
      type: paths[path] ? ("directory" as const) : undefined,
    })),
  );
}

describe("history-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkspaceHistoryServices();
    initMock.mockResolvedValue(undefined);
    ensureExcludeLinesMock.mockResolvedValue(undefined);
    moveDirectoryMock.mockResolvedValue({ ok: true, value: undefined });
    setExisting({});
  });

  it("resolves the gitdir to .metrists/.git", () => {
    expect(historyGitDir("/workspace/")).toBe(GIT_DIR);
  });

  it("builds the storage host lock-scoped to the history gitdir, not the workspace", () => {
    getOrCreateWorkspaceHistoryService(WS);

    expect(createGitStorageHostMock).toHaveBeenCalledWith(fsMock, GIT_DIR);
  });

  it("fresh workspace: inits at the new gitdir without touching migration", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    expect(moveDirectoryMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalledWith({
      repoPath: WS,
      gitDir: GIT_DIR,
      defaultBranch: "main",
    });
  });

  it("legacy gitdir present: renames it to .metrists/.git before init", async () => {
    setExisting({ [`${LEGACY_DIR}/HEAD`]: true });

    await ensureWorkspaceHistoryInitialized(WS);

    expect(moveDirectoryMock).toHaveBeenCalledWith(LEGACY_DIR, GIT_DIR);
    expect(moveDirectoryMock.mock.invocationCallOrder[0]).toBeLessThan(
      initMock.mock.invocationCallOrder[0],
    );
  });

  it("already migrated: never moves again even with a legacy dir left behind", async () => {
    setExisting({
      [`${GIT_DIR}/HEAD`]: true,
      [`${LEGACY_DIR}/HEAD`]: true,
    });

    await ensureWorkspaceHistoryInitialized(WS);

    expect(moveDirectoryMock).not.toHaveBeenCalled();
  });

  it("migration failure falls back to a fresh init without throwing", async () => {
    setExisting({ [`${LEGACY_DIR}/HEAD`]: true });
    moveDirectoryMock.mockResolvedValue({
      ok: false,
      error: { message: "cross-device link" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureWorkspaceHistoryInitialized(WS)).resolves.toBeTruthy();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitDir: GIT_DIR }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes the history repo's own exclude (.metrists/ and .git/)", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(GIT_DIR, [
      ".metrists/",
      ".git/",
    ]);
  });

  it("hides .metrists/ from the user's repo when the workspace has one", async () => {
    setExisting({ [`${WS}/.git`]: true });

    await ensureWorkspaceHistoryInitialized(WS);

    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(`${WS}/.git`, [
      ".metrists/",
    ]);
  });

  it("self-heals: a repo the user inits later gets the exclude on the next ensure", async () => {
    await ensureWorkspaceHistoryInitialized(WS);
    expect(ensureExcludeLinesMock).not.toHaveBeenCalledWith(`${WS}/.git`, [
      ".metrists/",
    ]);

    setExisting({ [`${GIT_DIR}/HEAD`]: true, [`${WS}/.git`]: true });
    await ensureWorkspaceHistoryInitialized(WS);

    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(`${WS}/.git`, [
      ".metrists/",
    ]);
  });

  it("exclude failures never block init", async () => {
    ensureExcludeLinesMock.mockRejectedValue(new Error("read-only fs"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureWorkspaceHistoryInitialized(WS)).resolves.toBeTruthy();

    warn.mockRestore();
  });
});
