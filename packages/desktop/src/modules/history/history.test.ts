import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRepoRef, GitService } from "@notefig/git";
import { createCore, createHooks } from "@notefig/core";
import { workspaceKey } from "@/utils/path";
import {
  createWorkspaceHistory,
  historyGitDir,
  historyModule,
  type HistoryDeps,
} from "@/modules/history";

const WS = "/workspace";
const GIT_DIR = "/workspace/.notefig/.git";

/** A disk the repo's excludes are written to, and the folders that exist. */
function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fs = {
    readFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths
        .filter((path) => files.has(path))
        .map((path) => ({ path, content: files.get(path)! })),
      failed: paths
        .filter((path) => !files.has(path))
        .map((path) => ({ path, type: "not_found", message: "not found" })),
    })),
    writeFiles: vi.fn(async (entries: { path: string; content: string }[]) => {
      for (const { path, content } of entries) files.set(path, content);
      return { succeeded: entries.map((entry) => entry.path), failed: [] };
    }),
    exists: vi.fn(async (paths: string[]) =>
      paths.map((path) => ({
        path,
        exists: dirs.has(path),
        type: dirs.has(path) ? "directory" : undefined,
      })),
    ),
  };
  return { fs: fs as unknown as HistoryDeps["fs"], raw: fs, files, dirs };
}

/** Where repos run: one fake service per created repo. */
function fakeGit() {
  const created: GitRepoRef[] = [];
  const init = vi.fn(async () => {});
  const git: HistoryDeps["git"] = {
    create: vi.fn((repo: GitRepoRef) => {
      created.push(repo);
      return { init } as unknown as GitService;
    }),
    dispose: vi.fn(),
  };
  return { git, created, init };
}

let disk: ReturnType<typeof memoryFs>;
let repos: ReturnType<typeof fakeGit>;

beforeEach(() => {
  disk = memoryFs();
  repos = fakeGit();
});

const history = () =>
  createWorkspaceHistory({
    workspacePath: WS,
    fs: disk.fs,
    git: repos.git,
    hooks: createHooks(),
  });

describe("a workspace's history repo", () => {
  it("resolves the gitdir to .notefig/.git", () => {
    expect(historyGitDir("/workspace/")).toBe(GIT_DIR);
  });

  it("binds its service to the history repo, once", () => {
    const repo = history();
    expect(repo.service()).toBe(repo.service());
    expect(repos.created).toEqual([{ repoPath: WS, gitDir: GIT_DIR }]);
  });

  it("inits at the gitdir and excludes everything under the app dir but the scratchpads", async () => {
    await history().ready();

    expect(repos.init).toHaveBeenCalledWith({ defaultBranch: "main" });
    // `dir/*` + `!dir/child` is the one git shape that re-includes inside
    // an excluded directory — history keeps checkpointing scratchpads while
    // never seeing the app's own gitdir or agent state.
    expect(disk.files.get(`${GIT_DIR}/info/exclude`)).toBe(
      ".notefig/*\n!.notefig/scratchpads\n.git/\n",
    );
  });

  it("hides .notefig/ from the user's repo once the workspace has one", async () => {
    const repo = history();
    await repo.ready();
    expect(disk.files.has(`${WS}/.git/info/exclude`)).toBe(false);

    // A repo the user inits later gets the exclude on the next ensure.
    disk.dirs.add(`${WS}/.git`);
    await repo.ready();

    expect(disk.files.get(`${WS}/.git/info/exclude`)).toBe(".notefig/\n");
  });

  it("never blocks init on an exclude it cannot write", async () => {
    disk.raw.writeFiles.mockResolvedValue({
      succeeded: [],
      failed: [{ path: "x", type: "permission_denied", message: "read-only" }],
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(history().ready()).resolves.toBeTruthy();

    warn.mockRestore();
  });

  it("initializes once for calls in flight together, and again for a later one", async () => {
    const repo = history();
    await Promise.all([repo.ready(), repo.ready()]);
    expect(repos.init).toHaveBeenCalledTimes(1);

    await repo.ready();
    expect(repos.init).toHaveBeenCalledTimes(2);
  });

  it("dispose drops the service and the worker's repo state", () => {
    const repo = history();
    repo.service();

    repo.dispose();

    expect(repos.git.dispose).toHaveBeenCalledWith(GIT_DIR);
    expect(() => repo.service()).toThrow(/closed/);
  });

  it("a ready still initializing when the workspace closes recreates nothing", async () => {
    let finishInit!: () => void;
    repos.init.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishInit = resolve)),
    );
    const repo = history();
    const pending = repo.ready();

    repo.dispose();
    finishInit();

    await expect(pending).rejects.toThrow(/closed/);
    expect(repos.created).toHaveLength(1);
  });
});

describe("historyModule", () => {
  it("checkpoints each completed agent turn in its own workspace", async () => {
    const core = createCore({
      // The repos run on the fake git worker, handed in where the
      // `gitWorker` module would be.
      services: { platform: { fs: disk.fs }, gitWorker: repos.git } as never,
      modules: [historyModule],
      workspaceKey,
    });
    await core.workspace(WS).open();
    const commit = vi
      .spyOn(core.workspace(WS).history, "checkpoint")
      .mockResolvedValue("abc123");

    const turn = { taskId: "t", turnId: "u", harnessId: "claude-code" };
    core.hooks.emit("agent:turn-completed", {
      ...turn,
      workspacePath: "/elsewhere",
      prompt: "not here",
    });
    core.hooks.emit("agent:turn-completed", {
      ...turn,
      workspacePath: WS,
      prompt: "x".repeat(80),
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(`${"x".repeat(69)}…`, {
      name: "claude-code",
      email: "agent@notefig.local",
    });
    await core.dispose();
  });
});
