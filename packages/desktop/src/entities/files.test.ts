import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  BatchResult,
  FileSystemMetadata,
  FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { createWorkspaceFiles, type WorkspaceFiles } from "./files";

// Real TanStack DB collections over an fs handed to them. This pins the
// create → write → read → delete round-trip through the actual metadata and
// content collections and their write-through mutation handlers.
const adapter = {
  createFiles: vi.fn(),
  writeFiles: vi.fn(),
  deleteFiles: vi.fn(),
  getMetadata: vi.fn(),
  readFiles: vi.fn(),
  readDirectory: vi.fn(),
  // The instance watches from the start; nothing here reports changes.
  onFsEvent: vi.fn(() => () => {}),
  startWatchingMetadata: vi.fn(async () => {}),
  startWatchingContent: vi.fn(async () => {}),
  stopWatching: vi.fn(async () => {}),
};

function ok<T>(succeeded: T[]): BatchResult<T> {
  return { succeeded, failed: [] };
}

function metadata(path: string, size: number): FileSystemMetadata {
  return {
    path,
    type: "file",
    size,
    modifiedAt: new Date(1_700_000_000_000),
    createdAt: new Date(1_700_000_000_000),
  };
}

const WS = "/ws-files-test";
const FILE = `${WS}/notes.md`;

let files: WorkspaceFiles;

beforeEach(async () => {
  vi.clearAllMocks();
  // A tiny faithful disk: create awaits its insert's persistence, which
  // triggers the collection's post-mutation refetch — the walk must list
  // the created file like a real filesystem would, or the fresh row gets
  // full-replaced away.
  const disk = new Set<string>();
  adapter.createFiles.mockImplementation(async (paths: string[]) => {
    paths.forEach((p) => disk.add(p));
    return ok(paths);
  });
  adapter.writeFiles.mockImplementation(
    async (writes: { path: string }[]) => {
      writes.forEach((w) => disk.add(w.path));
      return ok(writes.map((w) => w.path));
    },
  );
  adapter.deleteFiles.mockImplementation(async (paths: string[]) => {
    paths.forEach((p) => disk.delete(p));
    return ok(paths);
  });
  // Honor the requested paths — the metadata queryFn calls this with the
  // directory listing, so a blanket return would seed the collection with
  // FILE before create ever runs.
  adapter.getMetadata.mockImplementation(async (paths: string[]) =>
    ok(paths.includes(FILE) ? [metadata(FILE, 5)] : []),
  );
  adapter.readFiles.mockResolvedValue(ok([{ path: FILE, content: "hello" }]));
  adapter.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: [...disk].map((p) => ({ path: p, type: "file" as const })),
  }));

  files = createWorkspaceFiles({
    workspacePath: WS,
    fs: adapter as unknown as FileSystemSurface,
    queryClient: new QueryClient(),
  });

  // Start the collections' sync (a live-query subscription does this in the
  // app) so the mutation handlers' direct writeUpsert lands in a ready store.
  await Promise.all([
    files.collections.metadata.preload(),
    files.collections.content.preload(),
  ]);
});

afterEach(() => {
  files.dispose();
});

describe("file create → write → read round-trip", () => {
  it("create writes to the fs and entry() joins metadata + content", async () => {
    await files.file(FILE).create("hello");

    // Wrote through to the real fs seam, not just the collection.
    expect(adapter.createFiles).toHaveBeenCalledWith([FILE]);
    expect(adapter.writeFiles).toHaveBeenCalledWith([
      { path: FILE, content: "hello" },
    ]);

    const entry = files.file(FILE).entry();
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      path: FILE,
      relativePath: "notes.md",
      type: "file",
      content: "hello",
    });
    // content + hash come from the same (content) row — never a mismatched pair.
    expect(entry?.contentHash).toBeTruthy();
  });

  it("write updates the existing content row in place", async () => {
    await files.file(FILE).create("hello");

    adapter.writeFiles.mockClear();
    adapter.writeFiles.mockResolvedValue(ok([FILE]));
    await files.file(FILE).write("goodbye");

    expect(adapter.writeFiles).toHaveBeenCalledWith([
      { path: FILE, content: "goodbye" },
    ]);
    expect(files.file(FILE).entry()?.content).toBe("goodbye");
  });

  it("entry() is null for an unknown path", () => {
    expect(files.file(`${WS}/missing.md`).entry()).toBeNull();
  });
});

describe("lazy stat hydration", () => {
  let SUB = "";
  let A = "";
  let B = "";

  beforeEach(() => {
    SUB = `${WS}/sub`;
    A = `${WS}/a.md`;
    B = `${WS}/sub/b.md`;
    // One typed listing: files and directories together.
    adapter.readDirectory.mockImplementation(async () => ({
      ok: true,
      value: [
        { path: SUB, type: "directory" as const },
        { path: A, type: "file" as const },
        { path: B, type: "file" as const },
      ],
    }));
    adapter.getMetadata.mockImplementation(async (paths: string[]) =>
      ok(
        paths.map((path) => ({
          ...metadata(path, 7),
          type: path === SUB ? ("directory" as const) : ("file" as const),
        })),
      ),
    );
  });

  it("the listing writes typed rows without stats and without a stat batch", async () => {
    adapter.getMetadata.mockClear();
    await files.refresh();

    const { metadata: rows } = files.collections;
    expect(rows.get(A)).toMatchObject({ type: "file", relativePath: "a.md" });
    expect(rows.get(SUB)?.type).toBe("directory");
    expect(rows.get(A)?.modified).toBeUndefined();
    expect(rows.get(B)?.modified).toBeUndefined();
    // No hydrated dirs yet — the refetch must not stat anything.
    expect(adapter.getMetadata).not.toHaveBeenCalled();
  });

  it("hydrateDirectoryStats stats direct children only", async () => {
    await files.refresh();
    adapter.getMetadata.mockClear();

    await files.hydrateDirectoryStats(WS);

    expect(adapter.getMetadata).toHaveBeenCalledTimes(1);
    const statted = adapter.getMetadata.mock.calls[0][0] as string[];
    expect(new Set(statted)).toEqual(new Set([SUB, A]));

    const { metadata: rows } = files.collections;
    expect(rows.get(A)?.modified).toBeInstanceOf(Date);
    expect(rows.get(SUB)?.modified).toBeInstanceOf(Date);
    // b.md lives one level deeper — untouched.
    expect(rows.get(B)?.modified).toBeUndefined();
  });

  it("refetch preserves hydrated stats and re-stats hydrated dirs", async () => {
    await files.refresh();
    await files.hydrateDirectoryStats(WS);

    // Stat source dries up: carried-forward stats must survive the refetch.
    adapter.getMetadata.mockClear();
    adapter.getMetadata.mockResolvedValue(ok([]));
    await files.refresh();

    // The refetch re-attempted the hydrated dir's children...
    const statted = adapter.getMetadata.mock.calls[0][0] as string[];
    expect(new Set(statted)).toEqual(new Set([SUB, A]));
    // ...and kept the previous stats when nothing came back.
    const { metadata: rows } = files.collections;
    expect(rows.get(A)?.modified).toBeInstanceOf(Date);
  });
});

describe("recreated files", () => {
  it("create clears a poisoned content row left by a prior life of the path", async () => {
    const collections = files.collections;
    collections.content.utils.writeUpsert([
      {
        path: FILE,
        content: "",
        contentHash: "x",
        error: "No such file or directory (os error 2)",
      },
    ]);

    await files.file(FILE).create();

    expect(collections.content.get(FILE)).toBeUndefined();
  });
});

describe("file delete", () => {
  it("delete removes the row and calls the fs", async () => {
    await files.file(FILE).create("hello");
    expect(files.file(FILE).entry()).not.toBeNull();

    await files.file(FILE).delete();

    expect(adapter.deleteFiles).toHaveBeenCalledWith([FILE]);
    expect(files.file(FILE).entry()).toBeNull();
  });
});
