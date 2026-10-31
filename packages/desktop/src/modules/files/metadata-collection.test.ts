import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  BatchResult,
  FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createHooks } from "@notefig/core";

// The metadata rows against a walk: what a landed listing drops, keeps and
// leaves alone, over a disk the test controls (and can hold a walk on).
const WS = "/ws-metadata-test";
const disk = new Set<string>();
let held: Promise<void> | null = null;

const adapter = {
  createFiles: vi.fn(async (paths: string[]) => {
    paths.forEach((p) => disk.add(p));
    return ok(paths);
  }),
  deleteFiles: vi.fn(async (paths: string[]) => {
    paths.forEach((p) => disk.delete(p));
    return ok(paths);
  }),
  getMetadata: vi.fn(async () => ok([])),
  readFiles: vi.fn(async () => ok([])),
  readDirectory: vi.fn(async () => {
    const listing = [...disk].map((path) => ({ path, type: "file" as const }));
    await held;
    return { ok: true, value: listing };
  }),
  onFsEvent: vi.fn(() => () => {}),
  startWatchingMetadata: vi.fn(async () => {}),
  startWatchingContent: vi.fn(async () => {}),
  stopWatching: vi.fn(async () => {}),
};

function ok<T>(succeeded: T[]): BatchResult<T> {
  return { succeeded, failed: [] };
}

function row(path: string) {
  return {
    path,
    relativePath: path.slice(WS.length + 1),
    type: "file" as const,
    contentHash: "",
  };
}

let files: WorkspaceFiles;

beforeEach(async () => {
  vi.clearAllMocks();
  disk.clear();
  held = null;
  disk.add(`${WS}/a.md`);
  disk.add(`${WS}/b.md`);
  files = createWorkspaceFiles({
    workspacePath: WS,
    fs: adapter as unknown as FileSystemSurface,
    queryClient: new QueryClient(),
    hooks: createHooks(),
  });
  await files.collections.metadata.preload();
});

afterEach(() => {
  files.dispose();
});

const paths = () =>
  files.collections.metadata.toArray.map((r) => r.path).sort();

describe("metadata rows against the walk", () => {
  it("a walk drops what it no longer lists and adds what it newly does", async () => {
    disk.delete(`${WS}/a.md`);
    disk.add(`${WS}/c.md`);
    await files.refresh();
    expect(paths()).toEqual([`${WS}/b.md`, `${WS}/c.md`]);
  });

  it("a walk that predates a direct write neither drops nor overwrites it", async () => {
    let release!: () => void;
    held = new Promise((resolve) => (release = resolve));
    const walk = files.refresh();
    // Listed before the write: the walk's listing lacks c.md and has a.md.
    disk.add(`${WS}/c.md`);
    files.collections.metadata.utils.writeInsert(row(`${WS}/c.md`));
    files.collections.metadata.utils.writeUpdate({
      ...row(`${WS}/a.md`),
      size: 42,
    });
    release();
    await walk;
    expect(paths()).toEqual([`${WS}/a.md`, `${WS}/b.md`, `${WS}/c.md`]);
    expect(files.collections.metadata.get(`${WS}/a.md`)?.size).toBe(42);
  });

  it("a deletion one walk defers for a direct write, the next walk makes", async () => {
    disk.delete(`${WS}/a.md`);
    let release!: () => void;
    held = new Promise((resolve) => (release = resolve));
    const walk = files.refresh();
    // A write from stats taken before the deletion, landing mid-walk.
    files.collections.metadata.utils.writeUpdate({
      ...row(`${WS}/a.md`),
      size: 42,
    });
    release();
    await walk;
    expect(paths()).toContain(`${WS}/a.md`);
    held = null;
    await files.refresh();
    expect(paths()).toEqual([`${WS}/b.md`]);
  });

  it("keeps a directly written row no walk lists (an ignored path)", async () => {
    files.collections.metadata.utils.writeInsert(row(`${WS}/ignored.md`));
    await files.refresh();
    expect(paths()).toContain(`${WS}/ignored.md`);
  });

  it("creating a file confirms its row without a walk", async () => {
    adapter.readDirectory.mockClear();
    await files.file(`${WS}/new.md`).create();
    expect(paths()).toContain(`${WS}/new.md`);
    expect(adapter.readDirectory).not.toHaveBeenCalled();
  });

  it("a row the walk saw unchanged keeps its identity", async () => {
    const before = files.collections.metadata.get(`${WS}/b.md`);
    await files.refresh();
    expect(files.collections.metadata.get(`${WS}/b.md`)).toBe(before);
  });
});
