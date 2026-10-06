import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { createCore, defineModule, createHooks } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import type {
  BatchResult,
  FileSystemMetadata,
  FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { useOpenFileRows } from "@/modules/files/react";
import * as scratchpadsEntity from "@/modules/scratchpads";
import {
  createWorkspaceScratchpads,
  type WorkspaceScratchpads,
} from "@/modules/scratchpads";

// Real TanStack DB collections over an fs handed to them — same harness as
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
  onFsEvent: vi.fn(() => () => {}),
  startWatchingMetadata: vi.fn(async () => {}),
  startWatchingContent: vi.fn(async () => {}),
  stopWatching: vi.fn(async () => {}),
};
const fs = adapter as unknown as FileSystemSurface;

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

const WS = "/ws-scratchpads-test";
const DIR = `${WS}/.notefig/scratchpads`;

let files: WorkspaceFiles;
let pads: WorkspaceScratchpads;
const scratchpads = scratchpadsEntity;

/** What the scratchpads folder lists; the workspace walk itself (which
 *  enter and sweep re-run) always sees an empty workspace. */
function scratchpadDirLists(response: unknown) {
  adapter.readDirectory.mockImplementation(async (path: string) =>
    path === DIR ? response : { ok: true, value: [] },
  );
}

function seedFileRow(path: string) {
  files.collections.metadata.utils.writeUpsert([
    {
      path,
      relativePath: path.slice(WS.length + 1),
      type: "file" as const,
      contentHash: "",
    },
  ]);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
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

  files = createWorkspaceFiles({
    workspacePath: WS,
    fs,
    queryClient: new QueryClient(),
    hooks: createHooks(),
  });
  pads = createWorkspaceScratchpads({
    workspacePath: WS,
    files,
    fs,
    landsOnStartup: async () => true,
    openTab: vi.fn(),
  });
  await Promise.all([
    files.collections.metadata.preload(),
    files.collections.content.preload(),
  ]);
});

afterEach(() => {
  files.dispose();
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

  it("generates collision-free names, counter-suffixed as a last resort", () => {
    const first = scratchpads.randomScratchpadBasename([]);
    expect(first).toMatch(/^[a-z]+-[a-z]+\.md$/);
    expect(scratchpads.randomScratchpadBasename([first])).not.toBe(first);
    // Case-insensitive take: mac/Windows filesystems are.
    expect(
      scratchpads.randomScratchpadBasename([first.toUpperCase()]),
    ).not.toBe(first);
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

describe("create", () => {
  it("creates a generated-name file in the folder", async () => {
    const created = await pads.create();
    expect(created.startsWith(`${DIR}/`)).toBe(true);
    expect(created.slice(DIR.length + 1)).toMatch(/^[a-z]+-[a-z]+\.md$/);
    expect(adapter.createFiles).toHaveBeenCalledWith([created]);

    // A seeded sibling never collides — names dodge existing rows.
    seedFileRow(created);
    await expect(pads.create()).resolves.not.toBe(created);
  });

  it("throws when a file squats on the scratchpads dir path", async () => {
    files.collections.metadata.utils.writeUpsert([
      {
        path: DIR,
        relativePath: ".notefig/scratchpads",
        type: "file" as const,
        contentHash: "",
      },
    ]);

    await expect(pads.create()).rejects.toThrow(/occupies/);
    expect(adapter.createFiles).not.toHaveBeenCalled();
  });
});

describe("enter: where it lands, on disk truth", () => {
  function listDir(files: string[]) {
    scratchpadDirLists({
      ok: true,
      value: files.map((path) => ({ path, type: "file" as const })),
    });
  }

  it("creates a generated-name file when the folder is missing or empty", async () => {
    const expectFreshCreate = async () => {
      const resolved = await pads.enter([]);
      expect(resolved).not.toBeNull();
      expect(resolved!.startsWith(`${DIR}/`)).toBe(true);
      expect(resolved!.slice(DIR.length + 1)).toMatch(/^[a-z]+-[a-z]+\.md$/);
      expect(adapter.createFiles).toHaveBeenCalledWith([resolved]);
    };

    scratchpadDirLists({
      ok: false,
      error: { path: DIR, type: "not_found", message: "missing" },
    });
    await expectFreshCreate();

    adapter.createFiles.mockClear();
    listDir([]);
    await expectFreshCreate();
  });

  it("reuses the most recently modified existing scratchpad — no writes", async () => {
    listDir([`${DIR}/untitled.md`, `${DIR}/my-notes-a1b2.md`]);
    adapter.getMetadata.mockResolvedValue(
      ok([
        stat(`${DIR}/untitled.md`, 100),
        stat(`${DIR}/my-notes-a1b2.md`, 200),
      ]),
    );

    await expect(pads.enter([])).resolves.toBe(`${DIR}/my-notes-a1b2.md`);
    expect(adapter.createFiles).not.toHaveBeenCalled();
    expect(adapter.writeFiles).not.toHaveBeenCalled();
  });

  it("bails to null when the folder path is unusable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scratchpadDirLists({
      ok: false,
      error: { path: DIR, type: "is_file", message: "a file" },
    });
    await expect(pads.enter([])).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("sweep", () => {
  it("deletes whitespace-only leftovers, spares kept paths and content", async () => {
    const kept = `${DIR}/untitled-2.md`;
    const empty = `${DIR}/untitled-3.md`;
    const withContent = `${DIR}/untitled-4.md`;
    scratchpadDirLists({
      ok: true,
      value: [kept, empty, withContent].map((path) => ({
        path,
        type: "file" as const,
      })),
    });
    adapter.readFiles.mockResolvedValue(
      ok([
        { path: empty, content: "  \n" },
        { path: withContent, content: "# Notes" },
      ]),
    );

    await pads.sweep([kept]);

    expect(new Set(adapter.readFiles.mock.calls[0][0] as string[])).toEqual(
      new Set([empty, withContent]),
    );
    expect(adapter.deleteFiles).toHaveBeenCalledWith([empty]);
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
    expect(adapter.moveFile).not.toHaveBeenCalled();
  });

  it("sweeps empty scratchpads regardless of name — the folder is app territory", async () => {
    const renamedEmpty = `${DIR}/meeting-notes.md`;
    const untitledEmpty = `${DIR}/untitled.md`;
    scratchpadDirLists({
      ok: true,
      value: [renamedEmpty, untitledEmpty].map((path) => ({
        path,
        type: "file" as const,
      })),
    });
    adapter.readFiles.mockResolvedValue(
      ok([
        { path: renamedEmpty, content: "" },
        { path: untitledEmpty, content: "" },
      ]),
    );

    await pads.sweep([]);

    expect(new Set(adapter.deleteFiles.mock.calls[0][0] as string[])).toEqual(
      new Set([renamedEmpty, untitledEmpty]),
    );
    expect(adapter.deleteFiles).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the folder is missing", async () => {
    scratchpadDirLists({
      ok: false,
      error: { path: DIR, type: "not_found", message: "missing" },
    });
    await pads.sweep([]);
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
      useOpenFileRows(WS, [missing]);
      return null;
    }
    // The rows hook reads the workspace's files through core.
    const core = createCore({
      services: {} as never,
      modules: [
        defineModule({
          name: "files",
          workspace: { create: () => files },
        }),
      ],
    });
    await core.workspace(WS).open();
    await act(async () => {
      root.render(
        createElement(CoreProvider, { core, children: createElement(Probe) }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(adapter.readFiles).toHaveBeenCalled();
    const row = files.collections.content.get(missing);
    expect(row).toBeUndefined();

    await act(async () => root.unmount());
    container.remove();
    warn.mockRestore();
  });
});
