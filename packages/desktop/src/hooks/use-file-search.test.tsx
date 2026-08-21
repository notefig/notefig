import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  FileSearchOptions,
  FileSearchResult,
} from "@/hooks/use-file-search";

// Real TanStack DB collections, mocked fs seam (same harness as
// entities/files.test.ts): the hook is exercised against the actual metadata
// collection + live query, not a mock of the entities layer.
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

vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Fresh workspace per test — collections are keyed by workspace in a
// module-level registry, so reusing one path would leak rows across tests.
let testCounter = 0;
let WS = "";

const WORKSPACE_FILES = [
  "notes.md",
  "readme.md",
  "archive/old-notes.md",
  "image.png",
];
// Returned by the walk but outside the workspace root — a loose file, so its
// row gets no relativePath.
const LOOSE_FILE = "/elsewhere/loose-notes.md";

let files: typeof import("@/entities/files");
let useFileSearch: typeof import("@/hooks/use-file-search").useFileSearch;

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
    root!.render(createElement(Probe, { query, options }));
  });
  return latest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-file-search-${testCounter++}`;
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(
    async (_dir: string, options: { includeFiles: boolean }) => ({
      ok: true,
      value: options.includeFiles
        ? [...WORKSPACE_FILES.map((rel) => `${WS}/${rel}`), LOOSE_FILE]
        : [`${WS}/archive`],
    }),
  );

  files = await import("@/entities/files");
  ({ useFileSearch } = await import("@/hooks/use-file-search"));
  await files.getOrCreateWorkspaceCollections(WS).metadata.preload();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  files.clearWorkspaceCollections(WS);
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

  it("caps results at 10 by default", async () => {
    await act(async () => {
      const { metadata } = files.getOrCreateWorkspaceCollections(WS);
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
      files.getOrCreateWorkspaceCollections(WS).metadata.utils.writeInsert({
        path: `${WS}/brand-new.md`,
        relativePath: "brand-new.md",
        type: "file",
        contentHash: "",
      });
    });
    expect(latest.map((r) => r.relativePath)).toEqual(["brand-new.md"]);
  });
});
