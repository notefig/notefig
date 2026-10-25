import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import type {
  WorkspaceFileSearchOptions,
  WorkspaceFileSearchResult,
  WorkspaceFiles,
} from "@/modules/files";
import { useFileSearch } from "@/modules/files/react";
import { createTestCore } from "@/testing/test-core";
import { filesModuleOf, testWorkspaceFiles } from "@/testing/test-files";

// Real TanStack DB collections over a listing handed to them: the hook is
// exercised against the actual metadata collection + live query, read
// through core, not a mock of the entities layer.
const adapter = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
};

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws-file-search";
const WS2 = "/ws-file-search-2";
const WSNested = `${WS}/nested`;

const WORKSPACE_FILES = [
  "notes.md",
  "readme.md",
  "archive/old-notes.md",
  "image.png",
];
// Returned by the walk but outside the workspace root — a loose file, so its
// row gets no relativePath.
const LOOSE_FILE = "/elsewhere/loose-notes.md";
const WS2_FILES = ["other.md", "project/notes.md"];

const adapter2 = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
};

const adapterNested = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
};

let files: WorkspaceFiles;
let files2: WorkspaceFiles;
let filesNested: WorkspaceFiles;
let core: Core;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: WorkspaceFileSearchResult[] = [];

function Probe({
  query,
  options,
}: {
  query: string;
  options?: WorkspaceFileSearchOptions;
}) {
  latest = useFileSearch(query, options);
  return null;
}

async function renderSearch(
  query: string,
  options?: WorkspaceFileSearchOptions,
  strict = false,
) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const child = createElement(Probe, { query, options });
  await act(async () => {
    root!.render(
      createElement(CoreProvider, {
        core,
        children: strict ? createElement(StrictMode, null, child) : child,
      }),
    );
  });
  return latest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: [
      { path: `${WS}/archive`, type: "directory" as const },
      ...WORKSPACE_FILES.map((rel) => ({
        path: `${WS}/${rel}`,
        type: "file" as const,
      })),
      { path: LOOSE_FILE, type: "file" as const },
    ],
  }));
  adapter2.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter2.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: WS2_FILES.map((rel) => ({
      path: `${WS2}/${rel}`,
      type: "file" as const,
    })),
  }));
  adapterNested.getMetadata.mockResolvedValue({
    succeeded: [],
    failed: [],
  });
  adapterNested.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: [
      { path: `${WSNested}/shared.md`, type: "file" as const },
      { path: `${WSNested}/deep.md`, type: "file" as const },
    ],
  }));

  files = testWorkspaceFiles(WS, adapter);
  files2 = testWorkspaceFiles(WS2, adapter2);
  filesNested = testWorkspaceFiles(WSNested, adapterNested);
  core = createTestCore({
    modules: [filesModuleOf([files, files2, filesNested])],
  });
  await core.workspace(WS).open();
  await files.collections.metadata.preload();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  files.dispose();
  files2.dispose();
  filesNested.dispose();
});

describe("useFileSearch", () => {
  it("returns [] for an empty or whitespace query", async () => {
    expect(await renderSearch("")).toEqual([]);
    expect(await renderSearch("   ")).toEqual([]);
  });

  it("matches files by name, ranked basename-first, with title and paths", async () => {
    const results = await renderSearch("notes");
    expect(results.map((r) => r.relativePath)).toEqual([
      "notes.md",
      "archive/old-notes.md",
    ]);
    expect(results[0]).toMatchObject({
      path: `${WS}/notes.md`,
      title: "notes.md",
    });
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("excludes directories and loose rows (no relativePath)", async () => {
    const results = await renderSearch("archive");
    expect(results.map((r) => r.relativePath)).toEqual([
      "archive/old-notes.md",
    ]);
    // The loose file matches "notes" by name but has no relativePath.
    const noteResults = await renderSearch("loose-notes");
    expect(noteResults).toEqual([]);
  });

  it("applies the filter predicate", async () => {
    const all = await renderSearch("md");
    expect(all.some((r) => r.relativePath === "image.png")).toBe(false);
    expect(all.length).toBeGreaterThan(0);

    const filtered = await renderSearch("notes", {
      filter: (path) => !path.endsWith("notes.md"),
    });
    expect(filtered).toEqual([]);
  });

  it("respects the limit", async () => {
    const results = await renderSearch("md", { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("matchAllWhenEmpty lists files for an empty query, shallowest first", async () => {
    const results = await renderSearch("", { matchAllWhenEmpty: true });
    expect(results.map((r) => r.relativePath)).toEqual([
      "notes.md",
      "image.png",
      "readme.md",
      "archive/old-notes.md",
    ]);
    // Default behavior unchanged: empty query without the flag yields [].
    expect(await renderSearch("")).toEqual([]);
  });

  it("caps results at 10 by default", async () => {
    await act(async () => {
      const { metadata } = files.collections;
      for (let i = 0; i < 15; i++) {
        metadata.utils.writeInsert({
          path: `${WS}/bulk/file-${i}.md`,
          relativePath: `bulk/file-${i}.md`,
          type: "file",
          contentHash: "",
        });
      }
    });
    expect(await renderSearch("file-")).toHaveLength(10);
  });

  it("updates live when a row is inserted into the collection", async () => {
    expect(await renderSearch("brand-new")).toEqual([]);
    await act(async () => {
      files.collections.metadata.utils.writeInsert({
        path: `${WS}/brand-new.md`,
        relativePath: "brand-new.md",
        type: "file",
        contentHash: "",
      });
    });
    expect(latest.map((r) => r.relativePath)).toEqual(["brand-new.md"]);
  });
});

describe("useFileSearch across open workspaces", () => {
  beforeEach(async () => {
    await core.workspace(WS2).open();
    await files2.collections.metadata.preload();
  });

  it("returns matches from every open workspace", async () => {
    const results = await renderSearch("notes");
    const paths = results.map((r) => r.path);
    expect(paths).toContain(`${WS}/notes.md`);
    expect(paths).toContain(`${WS2}/project/notes.md`);
  });

  it("lists files from all open workspaces when the query is empty and matchAllWhenEmpty is true", async () => {
    const paths = (await renderSearch("", { matchAllWhenEmpty: true })).map(
      (r) => r.path,
    );
    expect(paths).toContain(`${WS}/notes.md`);
    expect(paths).toContain(`${WS2}/other.md`);
  });

  it("limits results after combining open workspaces", async () => {
    await act(async () => {
      const { metadata } = files2.collections;
      for (let i = 0; i < 15; i++) {
        metadata.utils.writeInsert({
          path: `${WS2}/bulk/file-${i}.md`,
          relativePath: `bulk/file-${i}.md`,
          type: "file",
          contentHash: "",
        });
      }
    });
    expect(await renderSearch("file-")).toHaveLength(10);
  });

  it("puts the preferred workspace first among equal scores", async () => {
    const notes = (path: string) => ({
      path,
      relativePath: "same/tie.md",
      type: "file" as const,
      contentHash: "",
    });
    await act(async () => {
      files.collections.metadata.utils.writeInsert(notes(`${WS}/same/tie.md`));
      files2.collections.metadata.utils.writeInsert(
        notes(`${WS2}/same/tie.md`),
      );
    });
    const first = async (preferWorkspace: string) =>
      (await renderSearch("tie", { preferWorkspace }))[0]?.workspacePath;
    expect(await first(WS)).toBe(WS);
    expect(await first(WS2)).toBe(WS2);
  });

  it("drops a closed workspace's files", async () => {
    expect((await renderSearch("other")).map((r) => r.path)).toContain(
      `${WS2}/other.md`,
    );
    await act(async () => {
      await core.workspace(WS2).close();
    });
    expect(latest.map((r) => r.path)).not.toContain(`${WS2}/other.md`);
  });
});

describe("useFileSearch with nested workspaces", () => {
  beforeEach(async () => {
    await core.workspace(WSNested).open();
    await filesNested.collections.metadata.preload();
  });

  it("deduplicates files that appear in both the parent and child workspaces, keeping the deeper relative path", async () => {
    // The parent workspace also lists the nested workspace's directory,
    // so its metadata will include a row for the nested file.
    await act(async () => {
      files.collections.metadata.utils.writeInsert({
        path: `${WSNested}/shared.md`,
        relativePath: "nested/shared.md",
        type: "file",
        contentHash: "",
      });
    });

    const results = await renderSearch("shared");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(`${WSNested}/shared.md`);
    // The inner workspace's relative path wins.
    expect(results[0].relativePath).toBe("shared.md");
    expect(results[0].workspacePath).toBe(WSNested);
  });
});

describe("useFileSearch under React StrictMode", () => {
  it("keeps updating after StrictMode effect replay", async () => {
    await renderSearch("strict-test", undefined, true);
    expect(latest).toEqual([]);

    await act(async () => {
      files.collections.metadata.utils.writeInsert({
        path: `${WS}/strict-test.md`,
        relativePath: "strict-test.md",
        type: "file",
        contentHash: "",
      });
    });

    expect(latest).toHaveLength(1);
    expect(latest[0].path).toBe(`${WS}/strict-test.md`);
  });
});
