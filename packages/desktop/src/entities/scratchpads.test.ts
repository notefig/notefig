import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  BatchResult,
  FileSystemMetadata,
} from "@/adapters/platform-adapter.interface";

// Real TanStack DB collections, mocked fs seam — same harness as
// files.test.ts.
const adapter = {
  createFiles: vi.fn(),
  createDirectories: vi.fn(),
  writeFiles: vi.fn(),
  deleteFiles: vi.fn(),
  deleteDirectories: vi.fn(),
  moveFile: vi.fn(),
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

vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));

vi.mock("./agents", () => ({ useAgentTasksReady: () => true }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function ok<T>(succeeded: T[]): BatchResult<T> {
  return { succeeded, failed: [] };
}

function stat(path: string, modifiedMs: number): FileSystemMetadata {
  return {
    path,
    type: "file",
    size: 1,
    modifiedAt: new Date(modifiedMs),
    createdAt: new Date(modifiedMs),
  };
}

let testCounter = 0;
let WS = "";
let DIR = "";

let files: typeof import("./files");
let scratchpads: typeof import("./scratchpads");

function seedFileRow(path: string) {
  files.getOrCreateWorkspaceCollections(WS).metadata.utils.writeUpsert([
    {
      path,
      relativePath: path.slice(WS.length + 1),
      type: "file" as const,
      contentHash: "",
    },
  ]);
}

function seedContentRow(path: string, content: string) {
  files
    .getOrCreateWorkspaceCollections(WS)
    .content.utils.writeUpsert([{ path, content, contentHash: "x" }]);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  WS = `/ws-scratchpads-test-${testCounter++}`;
  DIR = `${WS}/.notefig/scratchpads`;
  adapter.createFiles.mockImplementation(async (paths: string[]) => ok(paths));
  adapter.writeFiles.mockImplementation(async (writes: { path: string }[]) =>
    ok(writes),
  );
  adapter.deleteFiles.mockImplementation(async (paths: string[]) => ok(paths));
  adapter.deleteDirectories.mockImplementation(async (paths: string[]) =>
    ok(paths),
  );
  adapter.moveFile.mockResolvedValue({ ok: true, value: undefined });
  adapter.getMetadata.mockResolvedValue(ok([]));
  adapter.readFiles.mockResolvedValue(ok([]));
  adapter.readDirectory.mockResolvedValue({ ok: true, value: [] });

  files = await import("./files");
  scratchpads = await import("./scratchpads");

  const collections = files.getOrCreateWorkspaceCollections(WS);
  await Promise.all([
    collections.metadata.preload(),
    collections.content.preload(),
  ]);
});

afterEach(() => {
  files.clearWorkspaceCollections(WS);
});

describe("path scheme & naming", () => {
  it("recognizes scratchpads by folder membership, not filename", () => {
    expect(
      scratchpads.isScratchpadFileRow({
        relativePath: ".notefig/scratchpads/anything.md",
        type: "file",
      }),
    ).toBe(true);
    expect(
      scratchpads.isScratchpadFileRow({
        relativePath: ".notefig/scratchpads/sub/a.md",
        type: "file",
      }),
    ).toBe(false);
    expect(
      scratchpads.isScratchpadFileRow({
        relativePath: ".notefig/scratchpads",
        type: "directory",
      }),
    ).toBe(false);
  });

  it("recognizes only its own generated basenames as untitled", () => {
    expect(scratchpads.isUntitledBasename("untitled.md")).toBe(true);
    expect(scratchpads.isUntitledBasename("untitled-2.md")).toBe(true);
    expect(scratchpads.isUntitledBasename("untitled-10.md")).toBe(true);
    expect(scratchpads.isUntitledBasename("meeting-notes.md")).toBe(false);
    expect(scratchpads.isUntitledBasename("untitled-notes.md")).toBe(false);
    expect(scratchpads.isUntitledBasename("untitled.txt")).toBe(false);
  });

  it("counts untitled names up first-free", () => {
    expect(scratchpads.nextUntitledBasename([])).toBe("untitled.md");
    expect(
      scratchpads.nextUntitledBasename(["untitled.md", "untitled-3.md"]),
    ).toBe("untitled-2.md");
  });

  it("picks the most recent candidate, deterministic without stats", () => {
    const at = (ms: number) => new Date(ms);
    expect(
      scratchpads.pickMostRecentScratchpad([
        { path: `${DIR}/a.md`, modifiedAt: at(100) },
        { path: `${DIR}/b.md`, modifiedAt: at(300) },
      ]),
    ).toBe(`${DIR}/b.md`);
    expect(
      scratchpads.pickMostRecentScratchpad([
        { path: `${DIR}/zeta.md` },
        { path: `${DIR}/alpha.md`, modifiedAt: at(1) },
      ]),
    ).toBe(`${DIR}/alpha.md`);
  });

  it("protects only the app dir and the folder itself", () => {
    expect(scratchpads.isProtectedTreePath(".notefig")).toBe(true);
    expect(scratchpads.isProtectedTreePath(".notefig/scratchpads")).toBe(true);
    expect(scratchpads.isProtectedTreePath(".notefig/scratchpads/a.md")).toBe(
      false,
    );
  });
});

describe("createUntitledScratchpad", () => {
  it("creates untitled.md first, then counts up", async () => {
    await expect(scratchpads.createUntitledScratchpad(WS)).resolves.toBe(
      `${DIR}/untitled.md`,
    );
    expect(adapter.createFiles).toHaveBeenCalledWith([`${DIR}/untitled.md`]);

    seedFileRow(`${DIR}/untitled.md`);
    await expect(scratchpads.createUntitledScratchpad(WS)).resolves.toBe(
      `${DIR}/untitled-2.md`,
    );
  });

  it("throws when a file squats on the scratchpads dir path", async () => {
    files.getOrCreateWorkspaceCollections(WS).metadata.utils.writeUpsert([
      {
        path: DIR,
        relativePath: ".notefig/scratchpads",
        type: "file" as const,
        contentHash: "",
      },
    ]);

    await expect(scratchpads.createUntitledScratchpad(WS)).rejects.toThrow(
      /occupies/,
    );
    expect(adapter.createFiles).not.toHaveBeenCalled();
  });
});

describe("resolveScratchpadOnDisk", () => {
  function listDir(files: string[]) {
    adapter.readDirectory.mockResolvedValue({ ok: true, value: files });
  }

  it("creates untitled.md when the folder is missing or empty", async () => {
    adapter.readDirectory.mockResolvedValue({
      ok: false,
      error: { path: DIR, type: "not_found", message: "missing" },
    });
    await expect(scratchpads.resolveScratchpadOnDisk(WS)).resolves.toBe(
      `${DIR}/untitled.md`,
    );
    expect(adapter.createFiles).toHaveBeenCalledWith([`${DIR}/untitled.md`]);

    adapter.createFiles.mockClear();
    listDir([]);
    await expect(scratchpads.resolveScratchpadOnDisk(WS)).resolves.toBe(
      `${DIR}/untitled.md`,
    );
    expect(adapter.createFiles).toHaveBeenCalledWith([`${DIR}/untitled.md`]);
  });

  it("reuses the most recently modified existing scratchpad — no writes", async () => {
    listDir([`${DIR}/untitled.md`, `${DIR}/my-notes-a1b2.md`]);
    adapter.getMetadata.mockResolvedValue(
      ok([
        stat(`${DIR}/untitled.md`, 100),
        stat(`${DIR}/my-notes-a1b2.md`, 200),
      ]),
    );

    await expect(scratchpads.resolveScratchpadOnDisk(WS)).resolves.toBe(
      `${DIR}/my-notes-a1b2.md`,
    );
    expect(adapter.createFiles).not.toHaveBeenCalled();
    expect(adapter.writeFiles).not.toHaveBeenCalled();
  });

  it("bails to null when the folder path is unusable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    adapter.readDirectory.mockResolvedValue({
      ok: false,
      error: { path: DIR, type: "is_file", message: "a file" },
    });
    await expect(scratchpads.resolveScratchpadOnDisk(WS)).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("sweepScratchpadsOnDisk", () => {
  it("deletes whitespace-only leftovers, spares kept paths and content", async () => {
    const kept = `${DIR}/untitled-2.md`;
    const empty = `${DIR}/untitled-3.md`;
    const withContent = `${DIR}/untitled-4.md`;
    adapter.readDirectory.mockResolvedValue({
      ok: true,
      value: [kept, empty, withContent],
    });
    adapter.readFiles.mockResolvedValue(
      ok([
        { path: empty, content: "  \n" },
        { path: withContent, content: "# Notes" },
      ]),
    );

    await scratchpads.sweepScratchpadsOnDisk(WS, [kept]);

    expect(new Set(adapter.readFiles.mock.calls[0][0] as string[])).toEqual(
      new Set([empty, withContent]),
    );
    expect(adapter.deleteFiles).toHaveBeenCalledWith([empty]);
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
    expect(adapter.moveFile).not.toHaveBeenCalled();
  });

  it("never touches renamed scratchpads, even empty ones", async () => {
    const renamedEmpty = `${DIR}/meeting-notes.md`;
    const untitledEmpty = `${DIR}/untitled.md`;
    adapter.readDirectory.mockResolvedValue({
      ok: true,
      value: [renamedEmpty, untitledEmpty],
    });
    adapter.readFiles.mockResolvedValue(
      ok([{ path: untitledEmpty, content: "" }]),
    );

    await scratchpads.sweepScratchpadsOnDisk(WS, []);

    // The renamed file is never even read — it can't qualify.
    expect(adapter.readFiles).toHaveBeenCalledWith([untitledEmpty]);
    expect(adapter.deleteFiles).toHaveBeenCalledWith([untitledEmpty]);
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the folder is missing", async () => {
    adapter.readDirectory.mockResolvedValue({
      ok: false,
      error: { path: DIR, type: "not_found", message: "missing" },
    });
    await scratchpads.sweepScratchpadsOnDisk(WS, []);
    expect(adapter.readFiles).not.toHaveBeenCalled();
  });
});

describe("content loads for missing files", () => {
  it("a not_found read never fabricates a poisoned content row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = `${DIR}/untitled.md`;
    seedFileRow(missing);
    adapter.readFiles.mockResolvedValue({
      succeeded: [],
      failed: [{ path: missing, type: "not_found", message: "os error 2" }],
    });

    // Drive the on-demand content load the way an opening tab does.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() {
      files.useOpenFileRows(WS, [missing]);
      return null;
    }
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(adapter.readFiles).toHaveBeenCalled();
    const row = files.getOrCreateWorkspaceCollections(WS).content.get(missing);
    expect(row).toBeUndefined();

    await act(async () => root.unmount());
    container.remove();
    warn.mockRestore();
  });
});
