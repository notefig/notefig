import { beforeEach, describe, expect, it, vi } from "vitest";

const readFilesMock = vi.fn();
const writeFilesMock = vi.fn();

vi.mock("@/adapters", () => ({
  platformAdapter: {
    fs: {
      readFiles: (paths: string[]) => readFilesMock(paths),
      writeFiles: (files: { path: string; content: string }[]) =>
        writeFilesMock(files),
    },
  },
}));

import { ensureExcludeLines } from "../git-exclude";

function fileExists(content: string) {
  readFilesMock.mockResolvedValue({
    succeeded: [{ path: "/ws/.git/info/exclude", content }],
    failed: [],
  });
}

function fileMissing() {
  readFilesMock.mockResolvedValue({
    succeeded: [],
    failed: [{ path: "/ws/.git/info/exclude", message: "not found" }],
  });
}

describe("ensureExcludeLines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFilesMock.mockResolvedValue({ succeeded: [{}], failed: [] });
  });

  it("creates the file with the lines when it doesn't exist", async () => {
    fileMissing();

    await ensureExcludeLines("/ws/.git", [".metrists/"]);

    expect(writeFilesMock).toHaveBeenCalledWith([
      { path: "/ws/.git/info/exclude", content: ".metrists/\n" },
    ]);
  });

  it("appends only the missing lines, preserving existing content and order", async () => {
    fileExists("# stock comment\nuser-pattern.log\n.metrists/\n");

    await ensureExcludeLines("/ws/.git", [".metrists/", ".git/"]);

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: "/ws/.git/info/exclude",
        content: "# stock comment\nuser-pattern.log\n.metrists/\n.git/\n",
      },
    ]);
  });

  it("is idempotent — no write when every line is already present", async () => {
    fileExists("# stock comment\n.metrists/\n.git/\n");

    await ensureExcludeLines("/ws/.git", [".metrists/", ".git/"]);

    expect(writeFilesMock).not.toHaveBeenCalled();
  });

  it("adds a newline before appending to a file without a trailing one", async () => {
    fileExists("user-pattern.log");

    await ensureExcludeLines("/ws/.git", [".metrists/"]);

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: "/ws/.git/info/exclude",
        content: "user-pattern.log\n.metrists/\n",
      },
    ]);
  });

  it("throws when the write fails so callers can decide how loud to be", async () => {
    fileMissing();
    writeFilesMock.mockResolvedValue({
      succeeded: [],
      failed: [{ path: "/ws/.git/info/exclude", message: "disk full" }],
    });

    await expect(
      ensureExcludeLines("/ws/.git", [".metrists/"]),
    ).rejects.toThrow(/disk full/);
  });
});
