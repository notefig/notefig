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

const flushDocumentSyncMock = vi.fn();
let cleanPromise: Promise<void> = Promise.resolve();
vi.mock("@/utils/markdown-conversion", () => ({
  flushDocumentSync: (path: string) => flushDocumentSyncMock(path),
  whenDocumentSyncClean: () => cleanPromise,
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

/** Pin Math.random so auto-rename tails are predictable per test. */
function stubRandomTails(...values: number[]) {
  const spy = vi.spyOn(Math, "random");
  values.forEach((value) => spy.mockReturnValueOnce(value));
  spy.mockReturnValue(values[values.length - 1]);
  return values.map((value) =>
    value.toString(36).slice(2, 6).padEnd(4, "0"),
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  cleanPromise = Promise.resolve();
  WS = `/ws-scratchpads-test-${testCounter++}`;
  DIR = `${WS}/.metrists/scratchpads`;
  adapter.createFiles.mockImplementation(async (paths: string[]) => ok(paths));
  adapter.writeFiles.mockImplementation(async (writes: { path: string }[]) =>
    ok(writes),
  );
  adapter.deleteFiles.mockImplementation(async (paths: string[]) => ok(paths));
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
        relativePath: ".metrists/scratchpads/anything.md",
        type: "file",
      }),
    ).toBe(true);
    expect(
      scratchpads.isScratchpadFileRow({
        relativePath: ".metrists/scratchpads/sub/a.md",
        type: "file",
      }),
    ).toBe(false);
    expect(
      scratchpads.isScratchpadFileRow({
        relativePath: ".metrists/scratchpads",
        type: "directory",
      }),
    ).toBe(false);
    expect(scratchpads.isScratchpadPath(WS, `${DIR}/a.md`)).toBe(true);
    expect(scratchpads.isScratchpadPath(WS, `${WS}/a.md`)).toBe(false);
  });

  it("counts untitled names up first-free", () => {
    expect(scratchpads.nextUntitledBasename([])).toBe("untitled.md");
    expect(
      scratchpads.nextUntitledBasename(["untitled.md", "untitled-3.md"]),
    ).toBe("untitled-2.md");
    expect(scratchpads.isUntitledBasename("Untitled-7.md")).toBe(true);
    expect(scratchpads.isUntitledBasename("notes.md")).toBe(false);
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

  it("derives titles from the first heading, tolerating missing content", () => {
    expect(scratchpads.deriveScratchpadTitle("# My Notes\ntext")).toBe(
      "My Notes",
    );
    expect(scratchpads.deriveScratchpadTitle("no heading")).toBeNull();
    expect(scratchpads.deriveScratchpadTitle(undefined)).toBeNull();
  });

  it("slugifies titles to lowercase-dash with a length cap", () => {
    expect(scratchpads.slugifyScratchpadTitle("Plans: Q3/Q4 <draft>")).toBe(
      "plans-q3-q4-draft",
    );
    expect(
      scratchpads.slugifyScratchpadTitle("word ".repeat(20))!.length,
    ).toBeLessThanOrEqual(32);
    expect(scratchpads.slugifyScratchpadTitle("!!!")).toBeNull();
  });

  it("protects only the app dir and the folder itself", () => {
    expect(scratchpads.isProtectedTreePath(".metrists")).toBe(true);
    expect(scratchpads.isProtectedTreePath(".metrists/scratchpads")).toBe(true);
    expect(
      scratchpads.isProtectedTreePath(".metrists/scratchpads/a.md"),
    ).toBe(false);
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
        relativePath: ".metrists/scratchpads",
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

describe("resolveScratchpadToOpen", () => {
  it("reuses the most recently modified existing scratchpad — no writes", async () => {
    seedFileRow(`${DIR}/untitled.md`);
    seedFileRow(`${DIR}/my-notes-a1b2.md`);
    adapter.getMetadata.mockResolvedValue(
      ok([
        stat(`${DIR}/untitled.md`, 100),
        stat(`${DIR}/my-notes-a1b2.md`, 200),
      ]),
    );

    await expect(scratchpads.resolveScratchpadToOpen(WS)).resolves.toBe(
      `${DIR}/my-notes-a1b2.md`,
    );
    expect(adapter.createFiles).not.toHaveBeenCalled();
  });

  it("creates a fresh untitled file when none exist", async () => {
    await expect(scratchpads.resolveScratchpadToOpen(WS)).resolves.toBe(
      `${DIR}/untitled.md`,
    );
  });
});

describe("sweepEmptyScratchpads", () => {
  it("deletes whitespace-only leftovers, renames untitled ones with content, spares keepPath and open tabs", async () => {
    const [tail] = stubRandomTails(0.111);
    const keep = `${DIR}/untitled.md`;
    const open = `${DIR}/untitled-2.md`;
    const empty = `${DIR}/untitled-3.md`;
    const survivor = `${DIR}/untitled-4.md`;
    [keep, open, empty, survivor].forEach(seedFileRow);
    adapter.readFiles.mockResolvedValue(
      ok([
        { path: empty, content: "  \n" },
        { path: survivor, content: "# Crash Survivor" },
      ]),
    );

    await scratchpads.sweepEmptyScratchpads(WS, keep, [open]);

    expect(new Set(adapter.readFiles.mock.calls[0][0] as string[])).toEqual(
      new Set([empty, survivor]),
    );
    expect(adapter.deleteFiles).toHaveBeenCalledWith([empty]);
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
    expect(adapter.moveFile).toHaveBeenCalledWith(
      survivor,
      `${DIR}/crash-survivor-${tail}.md`,
    );
  });
});

describe("maybeGcScratchpadOnClose", () => {
  it("deletes a whitespace-only scratchpad on close", async () => {
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    seedContentRow(path, "  \n");

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    await settle();

    expect(flushDocumentSyncMock).toHaveBeenCalledWith(path);
    expect(adapter.deleteFiles).toHaveBeenCalledWith([path]);
  });

  it("renames an untitled scratchpad to a slug-with-random-tail name", async () => {
    const [tail] = stubRandomTails(0.222);
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    seedContentRow(path, "# Roadmap Ideas: Q3/Q4\n\nnotes");

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    await settle();

    expect(adapter.moveFile).toHaveBeenCalledWith(
      path,
      `${DIR}/roadmap-ideas-q3-q4-${tail}.md`,
    );
    expect(adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it("re-rolls the random tail on the (rare) collision", async () => {
    const [first, second] = stubRandomTails(0.333, 0.444);
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    seedFileRow(`${DIR}/roadmap-${first}.md`);
    seedContentRow(path, "# Roadmap");

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    await settle();

    expect(adapter.moveFile).toHaveBeenCalledWith(
      path,
      `${DIR}/roadmap-${second}.md`,
    );
  });

  it("keeps headingless content, never renames non-untitled files, ignores non-scratchpads", async () => {
    const untitled = `${DIR}/untitled.md`;
    seedFileRow(untitled);
    seedContentRow(untitled, "no heading here");
    scratchpads.maybeGcScratchpadOnClose(WS, untitled);

    const named = `${DIR}/my-notes.md`;
    seedFileRow(named);
    seedContentRow(named, "# Different Title");
    scratchpads.maybeGcScratchpadOnClose(WS, named);

    scratchpads.maybeGcScratchpadOnClose(WS, `${WS}/notes.md`);
    await settle();

    expect(adapter.moveFile).not.toHaveBeenCalled();
    expect(adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it("waits for the save pipeline before judging content", async () => {
    const [tail] = stubRandomTails(0.555);
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    let resolveClean!: () => void;
    cleanPromise = new Promise((resolve) => {
      resolveClean = resolve;
    });

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    seedContentRow(path, "# Late Save");
    await settle();
    expect(adapter.moveFile).not.toHaveBeenCalled();

    resolveClean();
    await settle();
    expect(adapter.moveFile).toHaveBeenCalledWith(
      path,
      `${DIR}/late-save-${tail}.md`,
    );
  });

  it("tolerates rename failure without blocking the close", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    seedContentRow(path, "# Doomed");
    adapter.moveFile.mockResolvedValue({
      ok: false,
      error: { path, type: "io_error", message: "disk full" },
    });

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    await settle();

    expect(warn).toHaveBeenCalled();
  });

  it("falls back to a disk read when no content row is loaded", async () => {
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    adapter.readFiles.mockResolvedValue(ok([{ path, content: "" }]));

    scratchpads.maybeGcScratchpadOnClose(WS, path);
    await settle();

    expect(adapter.readFiles).toHaveBeenCalledWith([path]);
    expect(adapter.deleteFiles).toHaveBeenCalledWith([path]);
  });
});

describe("metadata queryFn scratchpads sub-walk", () => {
  it("merges scratchpad entries with directory rows for the chain", async () => {
    adapter.readDirectory.mockImplementation(
      async (root: string, options: { includeFiles?: boolean }) =>
        root === DIR
          ? {
              ok: true,
              value: options.includeFiles ? [`${DIR}/untitled.md`] : [],
            }
          : { ok: true, value: [] },
    );

    const collections = files.getOrCreateWorkspaceCollections(WS);
    await collections.metadata.utils.refetch();

    expect(
      collections.metadata.toArray.map((r) => r.relativePath).sort(),
    ).toEqual([
      ".metrists",
      ".metrists/scratchpads",
      ".metrists/scratchpads/untitled.md",
    ]);
  });

  it("contributes nothing when the scratchpads dir is missing", async () => {
    adapter.readDirectory.mockImplementation(async (root: string) =>
      root === DIR
        ? {
            ok: false,
            error: { path: root, type: "not_found", message: "missing" },
          }
        : { ok: true, value: [] },
    );

    const collections = files.getOrCreateWorkspaceCollections(WS);
    await collections.metadata.utils.refetch();

    expect(collections.metadata.toArray).toEqual([]);
  });
});

describe("useScratchpadOnEmptyOpen", () => {
  const openFileMock = vi.fn(() => true);
  let container: HTMLDivElement;
  let root: Root;

  function Probe(props: { openTabs?: string[]; staleTabIds?: string[] }) {
    scratchpads.useScratchpadOnEmptyOpen({
      workspacePath: WS,
      openTabs: props.openTabs ?? [],
      staleTabIds: props.staleTabIds ?? [],
      isEntrySettled: true,
      openFile: openFileMock,
    });
    return null;
  }

  async function render(props: { openTabs?: string[]; staleTabIds?: string[] }) {
    await act(async () => {
      root.render(createElement(Probe, props));
    });
  }

  beforeEach(async () => {
    openFileMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // useMetadataReady needs a completed first load.
    await files.getOrCreateWorkspaceCollections(WS).metadata.utils.refetch();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens a scratchpad once on an empty entry and never re-fires", async () => {
    await render({});

    expect(adapter.createFiles).toHaveBeenCalledWith([`${DIR}/untitled.md`]);
    expect(openFileMock).toHaveBeenCalledWith({
      tabId: `${DIR}/untitled.md`,
      intent: "new-tab",
    });

    // Closing the last tab mid-session must not summon another.
    await render({ openTabs: [`${DIR}/untitled.md`] });
    await render({ openTabs: [] });
    expect(adapter.createFiles).toHaveBeenCalledTimes(1);
  });

  it("waits for stale tabs to prune, then treats the layout as empty", async () => {
    await render({ openTabs: [`${WS}/gone.md`], staleTabIds: [`${WS}/gone.md`] });
    expect(openFileMock).not.toHaveBeenCalled();

    await render({});
    expect(openFileMock).toHaveBeenCalledTimes(1);
  });

  it("only sweeps when tabs are open", async () => {
    seedFileRow(`${DIR}/untitled.md`);
    adapter.readFiles.mockResolvedValue(
      ok([{ path: `${DIR}/untitled.md`, content: " " }]),
    );

    await render({ openTabs: [`${WS}/notes.md`] });
    await settle();

    expect(openFileMock).not.toHaveBeenCalled();
    expect(adapter.deleteFiles).toHaveBeenCalledWith([`${DIR}/untitled.md`]);
  });
});
