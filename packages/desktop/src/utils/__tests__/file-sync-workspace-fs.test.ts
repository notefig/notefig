import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformAdapter } from "@/adapters";
import { FsError } from "@/adapters/platform-adapter.interface";
import {
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
  isRecentSelfWrite,
} from "../file-sync";
import { calculateContentHash } from "../hash";

vi.mock("@/adapters", () => ({
  platformAdapter: {
    readFiles: vi.fn(),
    writeFiles: vi.fn(),
  },
}));

const readMock = vi.mocked(platformAdapter.readFiles);
const writeMock = vi.mocked(platformAdapter.writeFiles);

beforeEach(() => {
  readMock.mockReset();
  writeMock.mockReset();
});

describe("writeWorkspaceTextFile", () => {
  it("writes through the platform adapter", async () => {
    writeMock.mockResolvedValue({ succeeded: ["/ws/a.md"], failed: [] });

    await writeWorkspaceTextFile("/ws/a.md", "hello\n");

    expect(writeMock).toHaveBeenCalledWith([
      { path: "/ws/a.md", content: "hello\n" },
    ]);
  });

  it("records a self-write so the watcher echo is suppressed", async () => {
    writeMock.mockResolvedValue({ succeeded: ["/ws/a.md"], failed: [] });

    await writeWorkspaceTextFile("/ws/a.md", "hello\n");

    expect(
      isRecentSelfWrite("/ws/a.md", calculateContentHash("hello\n")),
    ).toBe(true);
  });

  it("throws FsError on adapter failure", async () => {
    writeMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: "/ws/a.md", type: "NotFound", message: "no such file" },
      ] as never[],
    });

    await expect(
      writeWorkspaceTextFile("/ws/a.md", "hello\n"),
    ).rejects.toBeInstanceOf(FsError);
  });
});

describe("readWorkspaceTextFile", () => {
  it("reads through the platform adapter", async () => {
    readMock.mockResolvedValue({
      succeeded: [{ path: "/ws/a.md", content: "line1\nline2\nline3\n" }],
      failed: [],
    });

    const content = await readWorkspaceTextFile("/ws/a.md");

    expect(readMock).toHaveBeenCalledWith(["/ws/a.md"]);
    expect(content).toBe("line1\nline2\nline3\n");
  });

  it("slices content with 1-based line/limit", async () => {
    readMock.mockResolvedValue({
      succeeded: [{ path: "/ws/a.md", content: "line1\nline2\nline3\n" }],
      failed: [],
    });

    const content = await readWorkspaceTextFile("/ws/a.md", {
      line: 2,
      limit: 1,
    });

    expect(content).toBe("line2");
  });

  it("throws FsError on adapter failure", async () => {
    readMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: "/ws/a.md", type: "NotFound", message: "no such file" },
      ] as never[],
    });

    await expect(readWorkspaceTextFile("/ws/a.md")).rejects.toBeInstanceOf(
      FsError,
    );
  });
});
