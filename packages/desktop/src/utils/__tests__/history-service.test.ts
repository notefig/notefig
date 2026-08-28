import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  initMock,
  existsMock,
  moveDirectoryMock,
  fsMock,
  createGitStorageHostMock,
  ensureExcludeLinesMock,
  replaceExcludeLineMock,
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
    replaceExcludeLineMock: vi.fn(),
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
  replaceExcludeLine: replaceExcludeLineMock,
}));

import { IsomorphicGitService } from "@notefig/git";
import {
  clearWorkspaceHistoryServices,
  disposeWorkspaceHistoryService,
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
    replaceExcludeLineMock.mockResolvedValue(undefined);
    moveDirectoryMock.mockResolvedValue({ ok: true, value: undefined });
    setExisting({});
  });

  it("resolves the gitdir to .metrists/.git", () => {
    expect(historyGitDir("/workspace/")).toBe(GIT_DIR);
  });

  it("binds the service to the history repo: host lock scope AND repo ref", () => {
    getOrCreateWorkspaceHistoryService(WS);

    expect(createGitStorageHostMock).toHaveBeenCalledWith(fsMock, GIT_DIR);
    // The repo identity is bound once, at construction — calls can no
    // longer aim operations at another repo's gitdir.
    expect(vi.mocked(IsomorphicGitService)).toHaveBeenCalledWith(
      expect.anything(),
      { repoPath: WS, gitDir: GIT_DIR },
    );
  });

  it("fresh workspace: inits at the new gitdir without touching migration", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    expect(moveDirectoryMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalledWith({ defaultBranch: "main" });
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

    expect(initMock).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("narrows the history repo's exclude to app-internal subtrees (scratchpads stay tracked)", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    // Migrates a pre-MET-135 blanket `.metrists/` line in place; the
    // scratchpads folder must NOT appear here — history checkpoints it.
    expect(replaceExcludeLineMock).toHaveBeenCalledWith(GIT_DIR, ".metrists/", [
      ".metrists/.git/",
      ".metrists/.agent/",
      ".metrists/agent/",
      ".metrists/history/",
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
    replaceExcludeLineMock.mockRejectedValue(new Error("read-only fs"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureWorkspaceHistoryInitialized(WS)).resolves.toBeTruthy();

    warn.mockRestore();
  });

  // Registry semantics — this is the ONLY per-workspace git service registry
  // (entities/git.ts delegates here rather than keeping a second one aimed
  // at a different gitdir).
  it("returns a singleton service per normalized workspace", () => {
    const first = getOrCreateWorkspaceHistoryService("/workspace/");
    const second = getOrCreateWorkspaceHistoryService("/workspace");

    expect(first).toBe(second);
    expect(createGitStorageHostMock).toHaveBeenCalledTimes(1);
  });

  it("initializes once per in-flight workspace", async () => {
    await Promise.all([
      ensureWorkspaceHistoryInitialized(WS),
      ensureWorkspaceHistoryInitialized(WS),
    ]);

    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs init on later ensure calls", async () => {
    await ensureWorkspaceHistoryInitialized(WS);
    await ensureWorkspaceHistoryInitialized(WS);

    expect(initMock).toHaveBeenCalledTimes(2);
  });

  it("disposes a workspace's service entry", () => {
    const first = getOrCreateWorkspaceHistoryService(WS);
    disposeWorkspaceHistoryService(WS);
    const second = getOrCreateWorkspaceHistoryService(WS);

    expect(first).not.toBe(second);
    expect(createGitStorageHostMock).toHaveBeenCalledTimes(2);
  });
});
