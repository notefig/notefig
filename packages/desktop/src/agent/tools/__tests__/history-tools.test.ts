import { describe, it, expect, vi } from "vitest";

const { readTextFile, log, addAllAndCommit } = vi.hoisted(() => ({
  readTextFile: vi.fn(async () => "content"),
  log: vi.fn(async () => [
    {
      oid: "abc123",
      commit: {
        message: "checkpoint one\n",
        author: { name: "claude-code", timestamp: 1000 },
      },
    },
  ]),
  addAllAndCommit: vi.fn(async (..._args: unknown[]) => "def456"),
}));

vi.mock("@/utils/history-service", () => ({
  ensureWorkspaceHistoryInitialized: vi.fn(async () => ({
    readTextFile,
    log,
    addAllAndCommit,
  })),
  checkpointWorkspaceHistory: vi.fn(
    async (_ws: string, message: string, author: { name: string; email: string }) =>
      addAllAndCommit({ message, author }),
  ),
  historyGitDir: vi.fn((ws: string) => `${ws}/.metrists/history`),
}));

const { writeWorkspaceTextFile } = vi.hoisted(() => ({
  writeWorkspaceTextFile: vi.fn(async () => undefined),
}));
vi.mock("@/utils/file-sync", () => ({ writeWorkspaceTextFile }));

import { historyLog } from "../history-log";
import { historyDiff } from "../history-diff";
import { historyCheckpoint } from "../history-checkpoint";
import { historyRestore } from "../history-restore";

const ctx = { workspacePath: "/ws", taskId: "task_1", agents: {} as never };

describe("historyLog", () => {
  it("maps commits to log entries", async () => {
    const result = await historyLog.execute(ctx, {});
    expect(result).toEqual({
      ok: true,
      value: [
        {
          oid: "abc123",
          message: "checkpoint one",
          author: "claude-code",
          timestamp: 1000000,
        },
      ],
    });
  });
});

describe("historyDiff", () => {
  it("reads both checkpoints' content", async () => {
    readTextFile.mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    const result = await historyDiff.execute(ctx, {
      path: "notes.md",
      from: "abc",
      to: "def",
    });
    expect(result).toEqual({
      ok: true,
      value: { from: "abc", to: "def", fromContent: "v1", toContent: "v2" },
    });
  });
});

describe("historyCheckpoint", () => {
  it("commits an explicit checkpoint", async () => {
    const result = await historyCheckpoint.execute(ctx, { message: "manual save" });
    expect(result).toEqual({ ok: true, value: { oid: "def456" } });
    expect(addAllAndCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "manual save" }),
    );
  });
});

describe("historyRestore", () => {
  it("writes the checkpoint content through the file-sync write helper", async () => {
    readTextFile.mockResolvedValueOnce("old content");
    const result = await historyRestore.execute(ctx, {
      path: "notes.md",
      checkpoint: "abc123",
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(writeWorkspaceTextFile).toHaveBeenCalledWith("notes.md", "old content");
  });

  it("is marked as requiring permission", () => {
    expect(historyRestore.requiresPermission).toBe(true);
  });
});
