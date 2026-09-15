/**
 * The bridge is the single place the ACP path rules live, so the rules that
 * used to differ per host are asserted here rather than trusted.
 *
 * Containment gets the most attention: the path arrives from a process we
 * spawned but do not control, so traversal is reachable input.
 */
import { describe, expect, it, vi } from "vitest";
import { posix, win32 } from "@notefig/shared/utils";
import {
  createAcpFileSystem,
  resolveWithinWorkspace,
} from "../acp-file-system";
import { FsError, type CoreFileSystem } from "../fs";

/** An in-memory CoreFileSystem — enough for the bridge's four call paths. */
function fakeFs(files: Record<string, string> = {}): CoreFileSystem & {
  written: Record<string, string>;
} {
  const written: Record<string, string> = {};
  return {
    written,
    readFiles: async (paths) => {
      const succeeded: { path: string; content: string }[] = [];
      const failed = [];
      for (const p of paths) {
        if (p in files) succeeded.push({ path: p, content: files[p] });
        else failed.push({ path: p, type: "not_found" as const, message: "nope" });
      }
      return { succeeded, failed };
    },
    writeFiles: async (entries) => {
      for (const entry of entries) written[entry.path] = entry.content;
      return { succeeded: entries.map((e) => e.path), failed: [] };
    },
    getMetadata: async () => ({ succeeded: [], failed: [] }),
    exists: async (paths) => paths.map((p) => ({ path: p, exists: p in files })),
  };
}

describe("resolveWithinWorkspace", () => {
  const root = "/ws";

  it.each([
    ["a relative path", "notes/a.md", "/ws/notes/a.md"],
    ["an absolute path inside the root", "/ws/notes/a.md", "/ws/notes/a.md"],
    ["a redundant segment", "./notes/./a.md", "/ws/notes/a.md"],
    ["an interior traversal", "notes/../a.md", "/ws/a.md"],
    ["the root itself", ".", "/ws"],
  ])("resolves %s", (_label, target, expected) => {
    expect(resolveWithinWorkspace(posix, root, target)).toBe(expected);
  });

  it.each([
    ["a traversal out of the root", "../secrets.txt"],
    ["a deep traversal", "notes/../../secrets.txt"],
    ["an absolute path elsewhere", "/etc/passwd"],
    ["a sibling directory sharing a prefix", "/ws-backup/secrets.txt"],
  ])("refuses %s", (_label, target) => {
    expect(() => resolveWithinWorkspace(posix, root, target)).toThrow(FsError);
  });

  it("refuses a sibling prefix rather than slicing by string length", () => {
    // The historical `startsWith(root)` bug: /ws-backup starts with /ws.
    try {
      resolveWithinWorkspace(posix, root, "/ws-backup/x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FsError);
      expect((error as FsError).type).toBe("invalid_path");
    }
  });

  it("applies the host's flavor, not a hardcoded separator", () => {
    expect(resolveWithinWorkspace(win32, "C:\\ws", "notes\\a.md")).toBe(
      "C:\\ws\\notes\\a.md",
    );
    // win32 accepts mixed separators from harnesses that emit posix paths.
    expect(resolveWithinWorkspace(win32, "C:\\ws", "notes/a.md")).toBe(
      "C:\\ws\\notes\\a.md",
    );
    expect(() => resolveWithinWorkspace(win32, "C:\\ws", "..\\other")).toThrow(
      FsError,
    );
  });
});

describe("createAcpFileSystem", () => {
  it("reads through the host file system", async () => {
    const fs = fakeFs({ "/ws/a.md": "hello" });
    const bridge = createAcpFileSystem(fs, {
      workspacePath: "/ws",
      path: posix,
    });
    expect(await bridge.readTextFile("a.md")).toBe("hello");
  });

  it("applies ACP's 1-based line/limit window", async () => {
    const fs = fakeFs({ "/ws/a.md": "one\ntwo\nthree\nfour" });
    const bridge = createAcpFileSystem(fs, {
      workspacePath: "/ws",
      path: posix,
    });
    expect(await bridge.readTextFile("a.md", { line: 2, limit: 2 })).toBe(
      "two\nthree",
    );
  });

  it("surfaces a host read failure as FsError, not a raw batch entry", async () => {
    const bridge = createAcpFileSystem(fakeFs(), {
      workspacePath: "/ws",
      path: posix,
    });
    await expect(bridge.readTextFile("missing.md")).rejects.toBeInstanceOf(
      FsError,
    );
  });

  it("writes to the resolved absolute path", async () => {
    const fs = fakeFs();
    const bridge = createAcpFileSystem(fs, {
      workspacePath: "/ws",
      path: posix,
    });
    await bridge.writeTextFile("deep/new.md", "body");
    expect(fs.written).toEqual({ "/ws/deep/new.md": "body" });
  });

  it("refuses to write outside the workspace", async () => {
    const fs = fakeFs();
    const bridge = createAcpFileSystem(fs, {
      workspacePath: "/ws",
      path: posix,
    });
    await expect(
      bridge.writeTextFile("../escape.md", "x"),
    ).rejects.toBeInstanceOf(FsError);
    expect(fs.written).toEqual({});
  });
});
