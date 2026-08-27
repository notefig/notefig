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
  WS = `/ws-scratchpads-test-${testCounter++}`;
  DIR = `${WS}/.metrists/scratchpads`;
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
  it("deletes whitespace-only leftovers, renames untitled ones with content, spares open tabs", async () => {
    const [tail] = stubRandomTails(0.111);
    const open = `${DIR}/untitled-2.md`;
    const empty = `${DIR}/untitled-3.md`;
    const survivor = `${DIR}/untitled-4.md`;
    const named = `${DIR}/already-named.md`;
    [open, empty, survivor, named].forEach(seedFileRow);
    adapter.readFiles.mockResolvedValue(
      ok([
        { path: empty, content: "  \n" },
        { path: survivor, content: "# Crash Survivor" },
        { path: named, content: "# Different Title" },
      ]),
    );

    await scratchpads.sweepEmptyScratchpads(WS, [open]);

    expect(new Set(adapter.readFiles.mock.calls[0][0] as string[])).toEqual(
      new Set([empty, survivor, named]),
    );
    expect(adapter.deleteFiles).toHaveBeenCalledWith([empty]);
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
    expect(adapter.moveFile).toHaveBeenCalledWith(
      survivor,
      `${DIR}/crash-survivor-${tail}.md`,
    );
    expect(adapter.moveFile).toHaveBeenCalledTimes(1);
  });

  it("re-rolls the random tail on the (rare) collision", async () => {
    const [first, second] = stubRandomTails(0.333, 0.444);
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    seedFileRow(`${DIR}/roadmap-${first}.md`);
    adapter.readFiles.mockResolvedValue(ok([{ path, content: "# Roadmap" }]));

    await scratchpads.sweepEmptyScratchpads(WS, []);

    expect(adapter.moveFile).toHaveBeenCalledWith(
      path,
      `${DIR}/roadmap-${second}.md`,
    );
  });

  it("tolerates rename failure without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = `${DIR}/untitled.md`;
    seedFileRow(path);
    adapter.readFiles.mockResolvedValue(ok([{ path, content: "# Doomed" }]));
    adapter.moveFile.mockResolvedValue({
      ok: false,
      error: { path, type: "io_error", message: "disk full" },
    });

    await scratchpads.sweepEmptyScratchpads(WS, []);

    expect(warn).toHaveBeenCalled();
  });

  it("does nothing when there are no candidates", async () => {
    await scratchpads.sweepEmptyScratchpads(WS, []);
    expect(adapter.readFiles).not.toHaveBeenCalled();
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
