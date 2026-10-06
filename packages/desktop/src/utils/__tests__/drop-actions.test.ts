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

const renameFileOrDirectory = vi.fn(
  async (_ws: string, _from: string, _to: string) => {},
);
/** What a move goes through: the files of the item's workspace. */
const deps = {
  filesOf: (workspacePath: string) => ({
    file: (filePath: string) => ({
      exists: () => false,
      rename: (newPath: string) =>
        renameFileOrDirectory(workspacePath, filePath, newPath),
    }),
    refresh: vi.fn(async () => {}),
  }),
  fs: {},
} as never;

const openPaths: string[] = [];
vi.mock("@/entities/editors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/entities/editors")>()),
  getAllEditorPaths: () => openPaths,
  getMarkdownEditor: () => null,
}));

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
    moveIntoFolder(
      deps,
      dragged("C:\\ws\\notes", "directory"),
      "C:\\ws\\notes\\sub",
    );
    await flush();
    expect(renameFileOrDirectory).not.toHaveBeenCalled();
  });

  it("refuses to move a directory that holds an open tab", async () => {
    openPaths.push("C:\\ws\\notes\\a.md");
    moveIntoFolder(
      deps,
      dragged("C:\\ws\\notes", "directory"),
      "C:\\ws\\archive",
    );
    await flush();
    expect(renameFileOrDirectory).not.toHaveBeenCalled();
  });

  it("allows a sibling whose name merely shares the prefix", async () => {
    moveIntoFolder(
      deps,
      dragged("C:\\ws\\notes", "directory"),
      "C:\\ws\\notes-backup",
    );
    await flush();
    expect(renameFileOrDirectory).toHaveBeenCalledWith(
      "C:\\ws",
      "C:\\ws\\notes",
      "C:\\ws\\notes-backup\\notes",
    );
  });
});
