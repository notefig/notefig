import { describe, expect, it, vi } from "vitest";
import { createTestCore } from "@/testing/test-core";
import { appDirExcludeModule, type AppDirExcludeFs } from "./app-dir-exclude";

const WS = "/workspace";
const EXCLUDE = `${WS}/.git/info/exclude`;

/** A disk the exclude is written to, and the folders that exist. */
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
  return { fs: fs as unknown as AppDirExcludeFs, raw: fs, files, dirs };
}

async function bootWith(disk: ReturnType<typeof memoryFs>) {
  const core = createTestCore({
    modules: [appDirExcludeModule],
    platform: { fs: disk.fs as never },
  });
  await core.boot();
  return core;
}

const turnIn = (workspacePath: string) => ({
  taskId: "t",
  turnId: "u",
  workspacePath,
  prompt: "p",
  harnessId: "h",
});

describe("appDirExcludeModule", () => {
  it("hides .notefig/ from the user's repo after a turn, once the workspace has one", async () => {
    const disk = memoryFs();
    const core = await bootWith(disk);

    core.hooks.emit("agent:turn-completed", turnIn(WS));
    await vi.waitFor(() => expect(disk.raw.exists).toHaveBeenCalled());
    expect(disk.files.has(EXCLUDE)).toBe(false);

    // A repo the user inits later gets the exclude on the next turn.
    disk.dirs.add(`${WS}/.git`);
    core.hooks.emit("agent:turn-completed", turnIn(`${WS}/`));

    await vi.waitFor(() => expect(disk.files.get(EXCLUDE)).toBe(".notefig/\n"));
    await core.dispose();
  });

  it("never throws on an exclude it cannot write", async () => {
    const disk = memoryFs();
    disk.dirs.add(`${WS}/.git`);
    disk.raw.writeFiles.mockResolvedValue({
      succeeded: [],
      failed: [{ path: EXCLUDE, message: "read-only" }],
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const core = await bootWith(disk);

    core.hooks.emit("agent:turn-completed", turnIn(WS));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
    await core.dispose();
  });
});
