/**
 * Containment for the ACP file-system methods.
 *
 * Each case below was reachable before this wrapper existed: the desktop
 * wired `fs/read_text_file` and `fs/write_text_file` straight to helpers
 * that asserted absoluteness and nothing else, so any absolute path a
 * harness sent reached the disk.
 */
import { describe, it, expect, vi } from "vitest";
import { posix, win32 } from "@notefig/shared/utils";
import { withWorkspaceContainment, AcpPathError } from "../acp-file-system";
import type { AcpFileSystem } from "../acp-client";

const WS = "/home/u/ws";

function inner() {
  return {
    readTextFile: vi.fn(async () => "content"),
    writeTextFile: vi.fn(async () => {}),
  } satisfies AcpFileSystem;
}

function contained(fs: AcpFileSystem, workspacePath = WS) {
  return withWorkspaceContainment(fs, { workspacePath, path: posix });
}

describe("paths that must be refused", () => {
  it("refuses an absolute path outside the workspace on write", async () => {
    const fs = inner();
    await expect(
      contained(fs).writeTextFile("/home/u/.zshrc", "pwned"),
    ).rejects.toBeInstanceOf(AcpPathError);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("refuses an absolute path outside the workspace on read", async () => {
    const fs = inner();
    await expect(
      contained(fs).readTextFile("/etc/passwd"),
    ).rejects.toBeInstanceOf(AcpPathError);
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it("refuses a `..` escape", async () => {
    const fs = inner();
    await expect(
      contained(fs).writeTextFile("../../.ssh/authorized_keys", "k"),
    ).rejects.toBeInstanceOf(AcpPathError);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("refuses a sibling sharing the root's name (prefix test would pass it)", async () => {
    const fs = inner();
    await expect(
      contained(fs).writeTextFile("/home/u/ws-backup/notes.md", "x"),
    ).rejects.toBeInstanceOf(AcpPathError);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("names the offending path on the error", async () => {
    await expect(
      contained(inner()).writeTextFile("/etc/hosts", "x"),
    ).rejects.toMatchObject({ path: "/etc/hosts" });
  });
});

describe("paths that must be allowed", () => {
  it("resolves a relative path against the root and passes it on absolute", async () => {
    const fs = inner();
    await contained(fs).writeTextFile("notes.md", "hello");
    expect(fs.writeTextFile).toHaveBeenCalledWith(`${WS}/notes.md`, "hello");
  });

  it("accepts an absolute path inside the workspace unchanged", async () => {
    const fs = inner();
    await contained(fs).readTextFile(`${WS}/deep/file.md`);
    expect(fs.readTextFile).toHaveBeenCalledWith(
      `${WS}/deep/file.md`,
      undefined,
    );
  });

  it("collapses an interior `..` that stays inside", async () => {
    const fs = inner();
    await contained(fs).writeTextFile("a/../b.md", "x");
    expect(fs.writeTextFile).toHaveBeenCalledWith(`${WS}/b.md`, "x");
  });

  it("forwards the read window untouched", async () => {
    const fs = inner();
    await contained(fs).readTextFile("notes.md", { line: 3, limit: 10 });
    expect(fs.readTextFile).toHaveBeenCalledWith(`${WS}/notes.md`, {
      line: 3,
      limit: 10,
    });
  });

  it("returns the inner result", async () => {
    await expect(contained(inner()).readTextFile("notes.md")).resolves.toBe(
      "content",
    );
  });
});

describe("windows flavor", () => {
  const WIN = "C:\\Users\\u\\ws";
  const win = (fs: AcpFileSystem) =>
    withWorkspaceContainment(fs, { workspacePath: WIN, path: win32 });

  it("refuses an escape", async () => {
    const fs = inner();
    await expect(
      win(fs).writeTextFile("C:\\Windows\\System32\\drivers\\etc\\hosts", "x"),
    ).rejects.toBeInstanceOf(AcpPathError);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("resolves a tree-path relative into native", async () => {
    const fs = inner();
    await win(fs).writeTextFile("sub/notes.md", "x");
    expect(fs.writeTextFile).toHaveBeenCalledWith(
      "C:\\Users\\u\\ws\\sub\\notes.md",
      "x",
    );
  });
});
