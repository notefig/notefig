import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  initMock,
  existsMock,
  fsMock,
  createWorkerGitServiceMock,
  disposeWorkerGitRepoMock,
  ensureExcludeLinesMock,
} = vi.hoisted(() => {
  const initMock = vi.fn();
  const existsMock = vi.fn();
  return {
    initMock,
    existsMock,
    fsMock: { exists: existsMock },
    createWorkerGitServiceMock: vi.fn(() => ({ init: initMock })),
    disposeWorkerGitRepoMock: vi.fn(),
    ensureExcludeLinesMock: vi.fn(),
  };
});

vi.mock("@/adapters", () => ({
  platformAdapter: { fs: fsMock },
}));

vi.mock("@/utils/git-worker-client", () => ({
  createWorkerGitService: createWorkerGitServiceMock,
  disposeWorkerGitRepo: disposeWorkerGitRepoMock,
  clearWorkerGitRepos: vi.fn(),
}));

vi.mock("@/utils/git-exclude", () => ({
  ensureExcludeLines: ensureExcludeLinesMock,
}));

import {
  clearWorkspaceHistoryServices,
  disposeWorkspaceHistoryService,
  ensureWorkspaceHistoryInitialized,
  getOrCreateWorkspaceHistoryService,
  historyGitDir,
} from "../history-service";

const WS = "/workspace";
const GIT_DIR = "/workspace/.notefig/.git";
const HISTORY_EXCLUDE = [".notefig/*", "!.notefig/scratchpads", ".git/"];

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
    setExisting({});
  });

  it("resolves the gitdir to .notefig/.git", () => {
    expect(historyGitDir("/workspace/")).toBe(GIT_DIR);
  });

  it("binds the service to the history repo: repo ref fixed at creation", () => {
    getOrCreateWorkspaceHistoryService(WS);

    // The repo identity is bound once, at construction — calls can no
    // longer aim operations at another repo's gitdir.
    expect(createWorkerGitServiceMock).toHaveBeenCalledWith({
      repoPath: WS,
      gitDir: GIT_DIR,
    });
  });

  it("inits at the gitdir", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    expect(initMock).toHaveBeenCalledWith({ defaultBranch: "main" });
  });

  it("excludes everything under the app dir but the scratchpads folder", async () => {
    await ensureWorkspaceHistoryInitialized(WS);

    // `dir/*` + `!dir/child` is the one git shape that re-includes inside
    // an excluded directory — history must keep checkpointing scratchpads
    // while never seeing the app's own gitdir or agent state.
    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(
      GIT_DIR,
      HISTORY_EXCLUDE,
    );
  });

  it("hides .notefig/ from the user's repo when the workspace has one", async () => {
    setExisting({ [`${WS}/.git`]: true });

    await ensureWorkspaceHistoryInitialized(WS);

    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(`${WS}/.git`, [
      ".notefig/",
    ]);
  });

  it("self-heals: a repo the user inits later gets the exclude on the next ensure", async () => {
    await ensureWorkspaceHistoryInitialized(WS);
    expect(ensureExcludeLinesMock).not.toHaveBeenCalledWith(`${WS}/.git`, [
      ".notefig/",
    ]);

    setExisting({ [`${WS}/.git`]: true });
    await ensureWorkspaceHistoryInitialized(WS);

    expect(ensureExcludeLinesMock).toHaveBeenCalledWith(`${WS}/.git`, [
      ".notefig/",
    ]);
  });

  it("exclude failures never block init", async () => {
    ensureExcludeLinesMock.mockRejectedValue(new Error("read-only fs"));
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
    expect(createWorkerGitServiceMock).toHaveBeenCalledTimes(1);
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
    expect(createWorkerGitServiceMock).toHaveBeenCalledTimes(2);
    // The worker's per-repo service (and object cache) is dropped too.
    expect(disposeWorkerGitRepoMock).toHaveBeenCalledWith(GIT_DIR);
  });
});
