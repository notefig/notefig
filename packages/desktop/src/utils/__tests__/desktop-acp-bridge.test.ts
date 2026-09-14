/**
 * The desktop half of "one ACP bridge, defined in core".
 *
 * Before `createDesktopAcpFileSystem` existed, the desktop handed
 * `readWorkspaceTextFile`/`writeWorkspaceTextFile` straight to the ACP client
 * while the CLI went through core's bridge, so the same path string from the
 * same harness behaved differently per host. The containment case below is
 * the one that mattered: `assertAbsoluteWorkspacePath` checks `isAbsolute`
 * and nothing else, so an absolute path outside the workspace reached disk.
 *
 * These assert the desktop now gets the protocol rules from core AND keeps
 * the desktop-shaped write underneath (the tracked, adopting primitive) —
 * the two halves that make this a wrapper rather than a straight
 * `createAcpFileSystem(platformAdapter.fs)`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformAdapter } from "@/adapters";
import { createDesktopAcpFileSystem } from "../file-sync";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      readFiles: vi.fn(),
      writeFiles: vi.fn(),
    },
  },
}));

const readMock = vi.mocked(platformAdapter.fs.readFiles);
const writeMock = vi.mocked(platformAdapter.fs.writeFiles);

const WS = "/ws";

beforeEach(() => {
  readMock.mockReset();
  writeMock.mockReset();
});

describe("createDesktopAcpFileSystem", () => {
  it("refuses a write that escapes the workspace by traversal", async () => {
    const fs = createDesktopAcpFileSystem(WS);

    await expect(
      fs.writeTextFile("../outside/secrets.txt", "pwned"),
    ).rejects.toThrow();

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("refuses a write to an absolute path outside the workspace", async () => {
    // The case the desktop accepted before: absolute, so the old
    // `assertAbsoluteWorkspacePath` was satisfied and the bytes landed.
    const fs = createDesktopAcpFileSystem(WS);

    await expect(
      fs.writeTextFile("/etc/hosts", "pwned"),
    ).rejects.toThrow();

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("does not treat a sibling with a shared prefix as inside", async () => {
    const fs = createDesktopAcpFileSystem(WS);

    await expect(
      fs.writeTextFile("/ws-backup/a.md", "pwned"),
    ).rejects.toThrow();

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("resolves a workspace-relative path instead of throwing", async () => {
    // The CLI resolved these; the desktop threw. Same harness, same string,
    // two behaviors — which is the drift the shared bridge removes.
    writeMock.mockResolvedValue({ succeeded: ["/ws/notes/a.md"], failed: [] });
    const fs = createDesktopAcpFileSystem(WS);

    await fs.writeTextFile("notes/a.md", "hello\n");

    expect(writeMock).toHaveBeenCalledWith([
      { path: "/ws/notes/a.md", content: "hello\n" },
    ]);
  });

  it("applies the ACP line/limit window once, on read", async () => {
    readMock.mockResolvedValue({
      succeeded: [{ path: "/ws/a.md", content: "l1\nl2\nl3\nl4\n" }],
      failed: [],
    });
    const fs = createDesktopAcpFileSystem(WS);

    const slice = await fs.readTextFile("a.md", { line: 2, limit: 2 });

    expect(slice).toBe("l2\nl3");
  });
});
