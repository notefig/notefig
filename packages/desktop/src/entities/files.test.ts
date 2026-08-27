import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BatchResult,
  FileSystemMetadata,
} from "@/adapters/platform-adapter.interface";

// Real TanStack DB collections, mocked fs seam. This pins the create → write →
// read → delete round-trip through the actual metadata/content collections and
// their write-through mutation handlers, not a mock of the entities layer.
const adapter = {
  createFiles: vi.fn(),
  writeFiles: vi.fn(),
  deleteFiles: vi.fn(),
  getMetadata: vi.fn(),
  readFiles: vi.fn(),
  readDirectory: vi.fn(),
};

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: adapter,
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

// Debounced invalidation — harmless in a unit test, but stub it so we don't
// depend on its timers.
vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));

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

// A fresh workspace path per test — collections are keyed by workspace in a
// module-level registry (and the QueryClient cache), so reusing one path would
// leak rows across tests.
let testCounter = 0;
let WS = "";
let FILE = "";

let files: typeof import("./files");

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-files-test-${testCounter++}`;
  FILE = `${WS}/notes.md`;
  adapter.createFiles.mockResolvedValue(ok([FILE]));
  adapter.writeFiles.mockResolvedValue(ok([FILE]));
  adapter.deleteFiles.mockResolvedValue(ok([FILE]));
  // Honor the requested paths — the metadata queryFn calls this with the
  // directory listing (empty here), so a blanket return would seed the
  // collection with FILE before createFile ever runs.
  adapter.getMetadata.mockImplementation(async (paths: string[]) =>
    ok(paths.includes(FILE) ? [metadata(FILE, 5)] : []),
  );
  adapter.readFiles.mockResolvedValue(ok([{ path: FILE, content: "hello" }]));
  adapter.readDirectory.mockResolvedValue({ ok: true, value: [] });

  files = await import("./files");

  // Start the collections' sync (a live-query subscription does this in the
  // app) so the mutation handlers' direct writeUpsert lands in a ready store.
  const collections = files.getOrCreateWorkspaceCollections(WS);
  await Promise.all([
    collections.metadata.preload(),
    collections.content.preload(),
  ]);
});

afterEach(() => {
  // Drop the singleton collections so state can't leak between tests.
  files.clearWorkspaceCollections(WS);
});

describe("file create → write → read round-trip", () => {
  it("createFile writes to the fs seam and getFileEntry joins metadata + content", async () => {
    await files.createFile(WS, FILE, "hello");

    // Wrote through to the real fs seam, not just the collection.
    expect(adapter.createFiles).toHaveBeenCalledWith([FILE]);
    expect(adapter.writeFiles).toHaveBeenCalledWith([
      { path: FILE, content: "hello" },
    ]);

    const entry = files.getFileEntry(WS, FILE);
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

  it("writeFileContent updates the existing content row in place", async () => {
    await files.createFile(WS, FILE, "hello");

    adapter.writeFiles.mockClear();
    adapter.writeFiles.mockResolvedValue(ok([FILE]));
    await files.writeFileContent(WS, FILE, "goodbye");

    expect(adapter.writeFiles).toHaveBeenCalledWith([
      { path: FILE, content: "goodbye" },
    ]);
    expect(files.getFileEntry(WS, FILE)?.content).toBe("goodbye");
  });

  it("getFileEntry returns null for an unknown path", () => {
    expect(files.getFileEntry(WS, `${WS}/missing.md`)).toBeNull();
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
    // The listing queryFn walks files and directories separately.
    adapter.readDirectory.mockImplementation(
      async (
        _root: string,
        options?: { includeFiles?: boolean; includeDirectories?: boolean },
      ) => ({
        ok: true,
        value:
          options?.includeDirectories && !options?.includeFiles
            ? [SUB]
            : [A, B],
      }),
    );
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
    await files.refreshDirectoryMetadata(WS);

    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    expect(rows.get(A)).toMatchObject({ type: "file", relativePath: "a.md" });
    expect(rows.get(SUB)?.type).toBe("directory");
    expect(rows.get(A)?.modified).toBeUndefined();
    expect(rows.get(B)?.modified).toBeUndefined();
    // No hydrated dirs yet — the refetch must not stat anything.
    expect(adapter.getMetadata).not.toHaveBeenCalled();
  });

  it("hydrateDirectoryStats stats direct children only", async () => {
    await files.refreshDirectoryMetadata(WS);
    adapter.getMetadata.mockClear();

    await files.hydrateDirectoryStats(WS, WS);

    expect(adapter.getMetadata).toHaveBeenCalledTimes(1);
    const statted = adapter.getMetadata.mock.calls[0][0] as string[];
    expect(new Set(statted)).toEqual(new Set([SUB, A]));

    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    expect(rows.get(A)?.modified).toBeInstanceOf(Date);
    expect(rows.get(SUB)?.modified).toBeInstanceOf(Date);
    // b.md lives one level deeper — untouched.
    expect(rows.get(B)?.modified).toBeUndefined();
  });

  it("refetch preserves hydrated stats and re-stats hydrated dirs", async () => {
    await files.refreshDirectoryMetadata(WS);
    await files.hydrateDirectoryStats(WS, WS);

    // Stat source dries up: carried-forward stats must survive the refetch.
    adapter.getMetadata.mockClear();
    adapter.getMetadata.mockResolvedValue(ok([]));
    await files.refreshDirectoryMetadata(WS);

    // The refetch re-attempted the hydrated dir's children...
    const statted = adapter.getMetadata.mock.calls[0][0] as string[];
    expect(new Set(statted)).toEqual(new Set([SUB, A]));
    // ...and kept the previous stats when nothing came back.
    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    expect(rows.get(A)?.modified).toBeInstanceOf(Date);
  });
});

describe("file delete", () => {
  it("deleteFileOrDirectory removes the row and calls the fs seam", async () => {
    await files.createFile(WS, FILE, "hello");
    expect(files.getFileEntry(WS, FILE)).not.toBeNull();

    await files.deleteFileOrDirectory(WS, FILE);

    expect(adapter.deleteFiles).toHaveBeenCalledWith([FILE]);
    expect(files.getFileEntry(WS, FILE)).toBeNull();
  });
});
