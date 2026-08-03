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

vi.mock("@/adapters", () => ({ platformAdapter: adapter }));

// Watcher self-write ledger — harmless in a unit test, but stub it so we don't
// depend on its timers.
vi.mock("@/utils/file-write-effects", () => ({
  recordSelfWrite: vi.fn(),
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

// The walk's view of disk, kept faithful to the mutation seams: files a
// test creates appear in subsequent listings and deleted ones disappear.
// Without this, a background refetch's full-replace races the assertions
// and wipes freshly created rows — a wipe that can't happen against a real
// fs, where the walk sees what was just written.
let listedFiles: string[] = [];

let files: typeof import("./files");

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-files-test-${testCounter++}`;
  FILE = `${WS}/notes.md`;
  listedFiles = [];
  adapter.createFiles.mockImplementation(async (paths: string[]) => {
    listedFiles.push(...paths);
    return ok(paths);
  });
  adapter.writeFiles.mockResolvedValue(ok([FILE]));
  adapter.deleteFiles.mockImplementation(async (paths: string[]) => {
    listedFiles = listedFiles.filter((p) => !paths.includes(p));
    return ok(paths);
  });
  // Honor the requested paths — the metadata queryFn calls this with the
  // directory listing, so a blanket return would seed the collection with
  // FILE before createFile ever runs.
  adapter.getMetadata.mockImplementation(async (paths: string[]) =>
    ok(paths.includes(FILE) ? [metadata(FILE, 5)] : []),
  );
  adapter.readFiles.mockResolvedValue(ok([{ path: FILE, content: "hello" }]));
  adapter.readDirectory.mockImplementation(
    async (_path: string, options?: { includeFiles?: boolean }) => ({
      ok: true,
      value: options?.includeFiles === false ? [] : [...listedFiles],
    }),
  );

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
        _path: string,
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

describe("loose files", () => {
  let LOOSE = "";
  let A = "";

  beforeEach(() => {
    LOOSE = `/elsewhere/loose-${testCounter}.md`;
    A = `${WS}/a.md`;
    adapter.readDirectory.mockImplementation(
      async (
        _path: string,
        options?: { includeFiles?: boolean; includeDirectories?: boolean },
      ) => ({
        ok: true,
        value: options?.includeFiles ? [A] : [],
      }),
    );
    adapter.getMetadata.mockImplementation(async (paths: string[]) =>
      ok(
        paths.filter((p) => p === LOOSE || p === A).map((p) => metadata(p, 9)),
      ),
    );
  });

  it("registerLooseFile inserts a row with no relativePath", async () => {
    await files.registerLooseFile(WS, LOOSE);

    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    expect(rows.get(LOOSE)).toMatchObject({
      path: LOOSE,
      type: "file",
      relativePath: undefined,
    });
    expect(rows.get(LOOSE)?.modified).toBeInstanceOf(Date);
    expect(files.isLooseFile(WS, LOOSE)).toBe(true);
  });

  it("the loose row survives the queryFn's full-replace refetch", async () => {
    await files.registerLooseFile(WS, LOOSE);
    await files.refreshDirectoryMetadata(WS);

    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    // Walked row and loose row coexist after the full replace.
    expect(rows.get(A)).toMatchObject({ relativePath: "a.md" });
    expect(rows.get(LOOSE)).toMatchObject({ relativePath: undefined });
  });

  it("a loose path whose stat fails drops out on refetch (stale-tab path)", async () => {
    await files.registerLooseFile(WS, LOOSE);
    expect(
      files.getOrCreateWorkspaceCollections(WS).metadata.get(LOOSE),
    ).toBeDefined();

    // File deleted externally: the stat no longer returns it.
    adapter.getMetadata.mockImplementation(async (paths: string[]) =>
      ok(paths.filter((p) => p === A).map((p) => metadata(p, 9))),
    );
    await files.refreshDirectoryMetadata(WS);

    const { metadata: rows } = files.getOrCreateWorkspaceCollections(WS);
    expect(rows.get(LOOSE)).toBeUndefined();
    // Registration stays — reconciliation (tab close) is what unregisters.
    expect(files.isLooseFile(WS, LOOSE)).toBe(true);
  });

  it("unregisterLooseFile drops the registration and both rows", async () => {
    await files.registerLooseFile(WS, LOOSE);
    await files.writeFileContent(WS, LOOSE, "loose content");
    // Let writeFileContent's un-awaited metadata refresh transaction commit;
    // unregistering mid-commit leaves the optimistic overlay row until the
    // next refetch excludes it (acceptable transient in the app).
    await new Promise((resolve) => setTimeout(resolve, 0));

    files.unregisterLooseFile(WS, LOOSE);

    const collections = files.getOrCreateWorkspaceCollections(WS);
    expect(files.isLooseFile(WS, LOOSE)).toBe(false);
    expect(collections.metadata.get(LOOSE)).toBeUndefined();
    expect(collections.content.get(LOOSE)).toBeUndefined();

    // And a refetch does not resurrect it.
    await files.refreshDirectoryMetadata(WS);
    expect(collections.metadata.get(LOOSE)).toBeUndefined();
  });

  it("resolveEditablePath admits registered loose paths only", async () => {
    await files.registerLooseFile(WS, LOOSE);

    // Registered loose file: allowed, absolute in both halves.
    expect(files.resolveEditablePath(WS, LOOSE)).toEqual({
      ok: true,
      absolute: LOOSE,
      relative: LOOSE,
    });
    // Dot-segment obfuscation of the same path still matches.
    expect(
      files.resolveEditablePath(WS, `/elsewhere/./${LOOSE.split("/").pop()}`),
    ).toMatchObject({ ok: true, absolute: LOOSE });
    // Unregistered out-of-root path: still rejected.
    expect(
      files.resolveEditablePath(WS, "/elsewhere/not-registered.md").ok,
    ).toBe(false);
    // Workspace-relative resolution unchanged.
    expect(files.resolveEditablePath(WS, "notes.md")).toMatchObject({
      ok: true,
      absolute: `${WS}/notes.md`,
      relative: "notes.md",
    });
  });

  it("writeFileContent refreshes the loose row's metadata after save", async () => {
    await files.registerLooseFile(WS, LOOSE);
    adapter.writeFiles.mockResolvedValue(ok([LOOSE]));

    await files.writeFileContent(WS, LOOSE, "hello loose");

    const entry = files.getFileEntry(WS, LOOSE);
    expect(entry?.content).toBe("hello loose");
    // The metadata row existed, so mtime/size/hash refreshed (files.ts
    // guards this update on row presence).
    expect(entry?.contentHash).toBeTruthy();
    expect(entry?.modified).toBeInstanceOf(Date);
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
