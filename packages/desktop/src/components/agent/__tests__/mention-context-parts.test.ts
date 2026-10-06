/**
 * The app's half of the "@" mention contract: turning a finished prompt's
 * tokens into file:// resource_link parts against the REAL workspace file
 * collections. The token scanning itself is pure and lives (and is tested) in
 * @notefig/widgets — what this pins is the resolution: only real files, never
 * directories, with paths percent-encoded per segment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { mentionContextParts } from "../prompt-widget-host";
import { createHooks } from "@notefig/core";

// Real TanStack DB collections over a listing handed to them (same harness
// as use-file-search.test.tsx).
const WS = "/ws-mention-context";
const fs = {
  getMetadata: vi.fn(async () => ({ succeeded: [], failed: [] })),
  readDirectory: vi.fn(async () => ({
    ok: true,
    value: [
      { path: `${WS}/archive`, type: "directory" as const },
      { path: `${WS}/notes.md`, type: "file" as const },
      { path: `${WS}/readme.md`, type: "file" as const },
      { path: `${WS}/archive/old.md`, type: "file" as const },
      { path: `${WS}/my spaced file.md`, type: "file" as const },
    ],
  })),
  onFsEvent: () => () => {},
  startWatchingMetadata: async () => {},
  stopWatching: async () => {},
} as unknown as FileSystemSurface;

let files: WorkspaceFiles;
const host = { mentionContextParts };

beforeEach(async () => {
  files = createWorkspaceFiles({
    workspacePath: WS,
    fs,
    queryClient: new QueryClient(),
    hooks: createHooks(),
  });
  await files.collections.metadata.preload();
});

afterEach(() => {
  files.dispose();
});

describe("mentionContextParts", () => {
  it("turns tokens naming real files into file:// resource_link parts", () => {
    const parts = host.mentionContextParts(
      files,
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
    expect(host.mentionContextParts(files, "see @archive")).toEqual([]);
    expect(host.mentionContextParts(files, "no refs")).toEqual([]);
  });

  it("resolves picker-inserted mentions whose paths contain spaces", () => {
    const parts = host.mentionContextParts(
      files,
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
