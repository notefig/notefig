import { describe, expect, it } from "vitest";
import {
  flatEntriesToTree,
  getDirectoryPath,
  getFileName,
  getFileNameWithoutExtension,
  joinPaths,
  resolveWorkspacePath,
  type FileEntries,
} from "../fs";
import { path as pathutil, workspaceKey } from "../path";
import {
  buildDirectoryUrl,
  buildEditFileUrl,
  buildPreviewFileUrl,
  getAbsolutePathFromUrl,
  getRelativePathForUrl,
} from "../routing";
import { isIgnoredPath } from "../ignore";
import { historyGitDir } from "../history-service";

/**
 * Characterization baseline for the Windows path migration (MET-157 B2).
 *
 * These pin today's behavior for the inputs macOS and web actually produce —
 * every one of these assertions must KEEP passing, unchanged, through every
 * PR of the pathutil migration. They are the proof that the posix flavor is
 * a behavioral identity and that persisted keys (trust, blob sessions, task
 * rows, history gitDir) keep their exact spelling on mac. New win32-flavor
 * behavior gets its own suite next to the pathutil module; it does not
 * belong here.
 */

const WS = "/Users/parsa/Documents/notes";

describe("normalizePath successors keep the historical mac spellings", () => {
  // normalizePath was deleted in the final migration PR; these pin that its
  // replacements reproduce its output for every input mac actually produced.
  // (The "/"-prepend for relative inputs was the one deliberately dropped
  // behavior — no real caller passed relative paths.)
  it("path.normalize keeps a clean absolute path unchanged", () => {
    expect(pathutil.normalize(WS)).toBe(WS);
  });

  it("strips trailing slashes except at root", () => {
    expect(pathutil.normalize(`${WS}/`)).toBe(WS);
    expect(pathutil.normalize("/")).toBe("/");
  });

  it("collapses duplicate slashes", () => {
    expect(pathutil.normalize("/Users//parsa///x")).toBe("/Users/parsa/x");
  });

  it("converts backslashes to slashes", () => {
    expect(pathutil.normalize("/Users/parsa\\odd\\name")).toBe(
      "/Users/parsa/odd/name",
    );
  });
});

describe("resolveWorkspacePath", () => {
  it("resolves a workspace-relative path", () => {
    expect(resolveWorkspacePath(WS, "canto/ii.md")).toEqual({
      ok: true,
      absolute: `${WS}/canto/ii.md`,
      relative: "canto/ii.md",
    });
  });

  it("accepts an absolute path inside the workspace", () => {
    expect(resolveWorkspacePath(WS, `${WS}/notes.md`)).toEqual({
      ok: true,
      absolute: `${WS}/notes.md`,
      relative: "notes.md",
    });
  });

  it("resolves the workspace root to an empty relative", () => {
    expect(resolveWorkspacePath(WS, WS)).toEqual({
      ok: true,
      absolute: WS,
      relative: "",
    });
  });

  it("collapses . and .. segments that stay inside", () => {
    expect(resolveWorkspacePath(WS, "a/./b/../c.md")).toEqual({
      ok: true,
      absolute: `${WS}/a/c.md`,
      relative: "a/c.md",
    });
  });

  it("rejects .. escapes", () => {
    const result = resolveWorkspacePath(WS, "../outside.md");
    expect(result.ok).toBe(false);
  });

  it("rejects absolute paths outside the workspace", () => {
    const result = resolveWorkspacePath(WS, "/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("does not treat a sibling with the workspace prefix as inside", () => {
    const result = resolveWorkspacePath(WS, `${WS}-backup/x.md`);
    expect(result.ok).toBe(false);
  });
});

describe("display helpers", () => {
  it("getFileName returns the last segment", () => {
    expect(getFileName(`${WS}/a/b.md`)).toBe("b.md");
    expect(getFileName(`${WS}/a/`)).toBe("a");
    expect(getFileName("")).toBe("");
  });

  it("getDirectoryPath returns everything but the last segment", () => {
    expect(getDirectoryPath(`${WS}/a/b.md`)).toBe(`${WS}/a`);
    expect(getDirectoryPath("/top.md")).toBe("/");
  });

  it("getFileNameWithoutExtension strips one extension", () => {
    expect(getFileNameWithoutExtension(`${WS}/note.draft.md`)).toBe(
      "note.draft",
    );
    expect(getFileNameWithoutExtension("README")).toBe("README");
  });

  it("joinPaths joins with single slashes and strips edge slashes", () => {
    expect(joinPaths("/a/", "/b/", "c.md")).toBe("a/b/c.md");
    expect(joinPaths(WS, "x.md")).toBe(`${WS.slice(1)}/x.md`);
  });
});

describe("flatEntriesToTree", () => {
  it("builds the tree, inventing implied parent directories", () => {
    const entries: FileEntries = {
      [`${WS}/a.md`]: {
        path: `${WS}/a.md`,
        relativePath: "a.md",
        type: "file",
        contentHash: "h1",
        content: "",
      },
      [`${WS}/sub/deep/b.md`]: {
        path: `${WS}/sub/deep/b.md`,
        relativePath: "sub/deep/b.md",
        type: "file",
        contentHash: "h2",
        content: "",
      },
    };

    const tree = flatEntriesToTree(entries, WS);

    expect(tree.map((n) => n.path)).toEqual([`${WS}/a.md`, `${WS}/sub`]);
    const sub = tree[1];
    expect(sub.type).toBe("directory");
    expect(sub.relativePath).toBe("sub");
    expect(sub.children?.map((n) => n.path)).toEqual([`${WS}/sub/deep`]);
    expect(sub.children?.[0].children?.map((n) => n.path)).toEqual([
      `${WS}/sub/deep/b.md`,
    ]);
  });
});

describe("routing builders", () => {
  it("buildEditFileUrl encodes base and absolute file path as segments", () => {
    expect(buildEditFileUrl(WS, `${WS}/a b.md`)).toBe(
      `/${encodeURIComponent(WS)}/edit/${encodeURIComponent(`${WS}/a b.md`)}`,
    );
  });

  it("buildPreviewFileUrl mirrors the edit shape", () => {
    expect(buildPreviewFileUrl(WS, `${WS}/x.md`)).toBe(
      `/${encodeURIComponent(WS)}/preview/${encodeURIComponent(`${WS}/x.md`)}`,
    );
  });

  it("buildDirectoryUrl encodes the workspace as one segment", () => {
    expect(buildDirectoryUrl(WS)).toBe(`/${encodeURIComponent(WS)}`);
  });

  it("route param round-trips byte-identical (registry keys depend on it)", () => {
    const segment = encodeURIComponent(WS);
    expect(getAbsolutePathFromUrl(segment)).toBe(WS);
  });

  it("getRelativePathForUrl derives the workspace-relative path", () => {
    expect(getRelativePathForUrl(WS, `${WS}/sub/x.md`)).toBe("sub/x.md");
  });
});

describe("key producers", () => {
  it("historyGitDir spelling (persisted via git config/locks — must never drift on mac)", () => {
    expect(historyGitDir(WS)).toBe(`${WS}/.notefig/.git`);
    expect(historyGitDir(`${WS}/`)).toBe(`${WS}/.notefig/.git`);
  });

  it("trust/TaskManager keys via workspaceKey are the identity on mac — persisted keys never change spelling", () => {
    expect(workspaceKey(WS)).toBe(WS);
    expect(`trust:${workspaceKey(WS)}`).toBe(`trust:${WS}`);
  });
});

describe("path.toFileUri", () => {
  it("percent-encodes per segment after file://", () => {
    expect(pathutil.toFileUri(`${WS}/a b.md`)).toBe(
      `file://${WS.split("/").map(encodeURIComponent).join("/")}/a%20b.md`,
    );
  });
});

describe("isIgnoredPath", () => {
  it("ignores dependency dirs inside the base but not the base's own components", () => {
    expect(isIgnoredPath(`${WS}/node_modules/x.md`, WS)).toBe(true);
    expect(isIgnoredPath(`${WS}/notes.md`, WS)).toBe(false);
  });

  it("a base living under an ignored-named ancestor is not swallowed", () => {
    const base = "/Users/parsa/build/ws";
    expect(isIgnoredPath(`${base}/notes.md`, base)).toBe(false);
  });
});
