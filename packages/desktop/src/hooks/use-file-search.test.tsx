import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import {
  useFileSearch,
  type FileSearchOptions,
  type FileSearchResult,
} from "@/hooks/use-file-search";
import type { WorkspaceFiles } from "@/modules/files";
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

const WORKSPACE_FILES = [
  "notes.md",
  "readme.md",
  "archive/old-notes.md",
  "image.png",
];
// Returned by the walk but outside the workspace root — a loose file, so its
// row gets no relativePath.
const LOOSE_FILE = "/elsewhere/loose-notes.md";

let files: WorkspaceFiles;
let core: Core;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: FileSearchResult[] = [];

function Probe({
  query,
  options,
}: {
  query: string;
  options?: FileSearchOptions;
}) {
  latest = useFileSearch(WS, query, options);
  return null;
}

async function renderSearch(query: string, options?: FileSearchOptions) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      createElement(CoreProvider, {
        core,
        children: createElement(Probe, { query, options }),
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

  files = testWorkspaceFiles(WS, adapter);
  core = createTestCore({ modules: [filesModuleOf([files])] });
  await core.workspace(WS).open();
  await files.collections.metadata.preload();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  files.dispose();
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
