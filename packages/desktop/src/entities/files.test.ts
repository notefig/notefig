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

describe("file delete", () => {
  it("deleteFileOrDirectory removes the row and calls the fs seam", async () => {
    await files.createFile(WS, FILE, "hello");
    expect(files.getFileEntry(WS, FILE)).not.toBeNull();

    await files.deleteFileOrDirectory(WS, FILE);

    expect(adapter.deleteFiles).toHaveBeenCalledWith([FILE]);
    expect(files.getFileEntry(WS, FILE)).toBeNull();
  });
});
