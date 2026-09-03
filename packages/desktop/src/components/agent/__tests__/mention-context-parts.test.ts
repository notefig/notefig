/**
 * The app's half of the "@" mention contract: turning a finished prompt's
 * tokens into file:// resource_link parts against the REAL workspace file
 * collections. The token scanning itself is pure and lives (and is tested) in
 * @notefig/widgets — what this pins is the resolution: only real files, never
 * directories, with paths percent-encoded per segment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real TanStack DB collections, mocked fs seam (same harness as
// use-file-search.test.tsx).
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

let testCounter = 0;
let WS = "";
let files: typeof import("@/entities/files");
let host: typeof import("../prompt-widget-host");

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-mention-context-${testCounter++}`;
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(
    async () => ({
      ok: true,
      value: [
        { path: `${WS}/archive`, type: "directory" as const },
        { path: `${WS}/notes.md`, type: "file" as const },
        { path: `${WS}/readme.md`, type: "file" as const },
        { path: `${WS}/archive/old.md`, type: "file" as const },
        { path: `${WS}/my spaced file.md`, type: "file" as const },
      ],
    }),
  );

  files = await import("@/entities/files");
  host = await import("../prompt-widget-host");
  await files.getOrCreateWorkspaceCollections(WS).metadata.preload();
});

afterEach(() => {
  files.clearWorkspaceCollections(WS);
});

describe("mentionContextParts", () => {
  it("turns tokens naming real files into file:// resource_link parts", () => {
    const parts = host.mentionContextParts(
      WS,
      "read @notes.md and @missing.md, also @archive/old.md.",
    );
    expect(parts).toEqual([
      {
        kind: "resource_link",
        path: `file://${WS}/notes.md`,
        name: "notes.md",
      },
      {
        kind: "resource_link",
        path: `file://${WS}/archive/old.md`,
        name: "archive/old.md",
      },
    ]);
  });

  it("skips directories and text without mentions", () => {
    expect(host.mentionContextParts(WS, "see @archive")).toEqual([]);
    expect(host.mentionContextParts(WS, "no refs")).toEqual([]);
  });

  it("resolves picker-inserted mentions whose paths contain spaces", () => {
    const parts = host.mentionContextParts(
      WS,
      "summarize @my spaced file.md please",
    );
    expect(parts).toEqual([
      {
        kind: "resource_link",
        path: `file://${WS}/my%20spaced%20file.md`,
        name: "my spaced file.md",
      },
    ]);
  });
});
