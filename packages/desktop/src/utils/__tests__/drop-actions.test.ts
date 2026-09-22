import { describe, expect, it, vi, beforeEach } from "vitest";
import { win32 } from "@notefig/shared/utils";

// The guards this file covers are containment checks, and containment is
// the one thing that differs by path flavor — so the suite runs against
// win32, where the historical `startsWith(path + "/")` form was false for
// every descendant and let a directory move inside itself.
vi.mock("@/utils/path", async () => {
  const shared = await import("@notefig/shared/utils");
  return { path: shared.win32, ...shared };
});

const renameFileOrDirectory = vi.fn(async () => {});
vi.mock("@/entities/files", () => ({
  file: vi.fn(),
  refreshDirectoryMetadata: vi.fn(async () => {}),
  renameFileOrDirectory: (...args: unknown[]) =>
    renameFileOrDirectory(...(args as [])),
}));

const openPaths: string[] = [];
vi.mock("@/components/editor/editor-store", () => ({
  getAllEditorPaths: () => openPaths,
  getMarkdownEditor: () => null,
}));

vi.mock("@/adapters", () => ({ platformAdapter: { fs: {} } }));

import { moveIntoFolder } from "@/utils/drop-actions";

function dragged(path: string, fileType: "file" | "directory") {
  return {
    kind: "file" as const,
    path,
    fileType,
    workspaceRoot: "C:\\ws",
    name: win32.basename(path),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("moveIntoFolder containment guards (win32)", () => {
  beforeEach(() => {
    renameFileOrDirectory.mockClear();
    openPaths.length = 0;
  });

  it("refuses to move a directory into its own descendant", async () => {
    moveIntoFolder(dragged("C:\\ws\\notes", "directory"), "C:\\ws\\notes\\sub");
    await flush();
    expect(renameFileOrDirectory).not.toHaveBeenCalled();
  });

  it("refuses to move a directory that holds an open tab", async () => {
    openPaths.push("C:\\ws\\notes\\a.md");
    moveIntoFolder(dragged("C:\\ws\\notes", "directory"), "C:\\ws\\archive");
    await flush();
    expect(renameFileOrDirectory).not.toHaveBeenCalled();
  });

  it("allows a sibling whose name merely shares the prefix", async () => {
    moveIntoFolder(dragged("C:\\ws\\notes", "directory"), "C:\\ws\\notes-backup");
    await flush();
    expect(renameFileOrDirectory).toHaveBeenCalledWith(
      "C:\\ws",
      "C:\\ws\\notes",
      "C:\\ws\\notes-backup\\notes",
    );
  });
});
