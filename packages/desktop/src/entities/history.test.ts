import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  logMock,
  restoreTreeMock,
  ensureMock,
  checkpointMock,
  gitDirMock,
  refreshMetadataMock,
  contentRefetchMock,
  contentGetMock,
  contentWriteDeleteMock,
  contentWriteUpsertMock,
  readFilesMock,
  cancelAgentTurnsMock,
  notifyRewoundMock,
} = vi.hoisted(() => {
  const logMock = vi.fn();
  const restoreTreeMock = vi.fn();
  return {
    logMock,
    restoreTreeMock,
    ensureMock: vi.fn(async () => ({
      log: logMock,
      restoreTree: restoreTreeMock,
    })),
    checkpointMock: vi.fn(),
    gitDirMock: vi.fn((ws: string) => `${ws}/.metrists/.git`),
    refreshMetadataMock: vi.fn(),
    contentRefetchMock: vi.fn(),
    contentGetMock: vi.fn(),
    contentWriteDeleteMock: vi.fn(),
    contentWriteUpsertMock: vi.fn(),
    readFilesMock: vi.fn(),
    cancelAgentTurnsMock: vi.fn(async () => undefined),
    notifyRewoundMock: vi.fn(),
  };
});

vi.mock("@/utils/history-service", () => ({
  ensureWorkspaceHistoryInitialized: ensureMock,
  checkpointWorkspaceHistory: checkpointMock,
  historyGitDir: gitDirMock,
  // Pass-through: serialization itself is exercised in history-service.test.ts.
  runExclusiveHistoryOp: vi.fn((_ws: string, op: () => Promise<unknown>) =>
    op(),
  ),
}));

vi.mock("./files", () => ({
  refreshDirectoryMetadata: refreshMetadataMock,
  getOrCreateWorkspaceCollections: vi.fn(() => ({
    content: {
      get: contentGetMock,
      utils: {
        refetch: contentRefetchMock,
        writeDelete: contentWriteDeleteMock,
        writeUpsert: contentWriteUpsertMock,
      },
    },
  })),
}));

vi.mock("@/adapters", () => ({
  platformAdapter: { fs: { readFiles: readFilesMock } },
}));

vi.mock("@/agent/agent-service", () => ({
  cancelWorkspaceAgentTurns: cancelAgentTurnsMock,
  notifyWorkspaceRewound: notifyRewoundMock,
}));

import { GitError } from "@notefig/git";
import {
  fetchHistoryRows,
  jumpToCheckpoint,
  saveManualCheckpoint,
  type HistoryCheckpointRow,
  type HistoryRepoRow,
} from "./history";

const WS = "/workspace";
const GIT_DIR = "/workspace/.metrists/.git";

function commitEntry(
  oid: string,
  message: string,
  timestamp: number,
): {
  oid: string;
  commit: { message: string; committer: { timestamp: number } };
} {
  return { oid, commit: { message, committer: { timestamp } } };
}

describe("entities/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logMock.mockResolvedValue([]);
    restoreTreeMock.mockResolvedValue({ restored: [], deleted: [] });
    checkpointMock.mockResolvedValue("oid-safety");
    contentGetMock.mockReturnValue(undefined);
    readFilesMock.mockResolvedValue({ succeeded: [], failed: [] });
  });

  it("maps commits to checkpoint rows, parsing the trailers", async () => {
    logMock.mockResolvedValue([
      commitEntry(
        "abc1234def",
        "Fix login\n\nNotefig-Task: tsk_1\nNotefig-Turn: trn_2\nNotefig-Role: agent\n",
        1_000,
      ),
      commitEntry(
        "fff9999aaa",
        "Manual checkpoint\n\nNotefig-Role: user\n",
        900,
      ),
    ]);

    const rows = await fetchHistoryRows(WS);

    expect(logMock).toHaveBeenCalledWith({
      repoPath: WS,
      gitDir: GIT_DIR,
      depth: 50,
    });
    const repo = rows.find((row) => row.kind === "repo") as HistoryRepoRow;
    expect(repo.initialized).toBe(true);
    const checkpoints = rows.filter(
      (row): row is HistoryCheckpointRow => row.kind === "checkpoint",
    );
    expect(checkpoints).toEqual([
      {
        id: "cp:abc1234def",
        kind: "checkpoint",
        oid: "abc1234def",
        hash: "abc1234",
        subject: "Fix login",
        role: "agent",
        taskId: "tsk_1",
        turnId: "trn_2",
        timestamp: 1_000_000,
      },
      {
        id: "cp:fff9999aaa",
        kind: "checkpoint",
        oid: "fff9999aaa",
        hash: "fff9999",
        subject: "Manual checkpoint",
        role: "user",
        taskId: undefined,
        turnId: undefined,
        timestamp: 900_000,
      },
    ]);
  });

  it("turns failures into errors-as-data on the repo row", async () => {
    ensureMock.mockRejectedValueOnce(
      new GitError("CorruptRepository", "bad object"),
    );

    const rows = await fetchHistoryRows(WS);

    expect(rows).toEqual([
      {
        id: "repo",
        kind: "repo",
        initialized: false,
        error: { code: "CorruptRepository", message: "bad object" },
      },
    ]);
  });

  it("jumpToCheckpoint takes a safety checkpoint, restores, then reconciles files", async () => {
    await jumpToCheckpoint(WS, {
      oid: "target-oid",
      hash: "target1",
      subject: "Fix login",
    });

    expect(checkpointMock).toHaveBeenCalledTimes(1);
    const [ws, message, author] = checkpointMock.mock.calls[0];
    expect(ws).toBe(WS);
    expect(message).toContain("Before jump to target1");
    expect(message).toContain("Notefig-Role: user");
    expect(author).toEqual({ name: "user", email: "user@notefig.local" });

    expect(restoreTreeMock).toHaveBeenCalledWith({
      repoPath: WS,
      gitDir: GIT_DIR,
      ref: "target-oid",
    });
    // Agent cancellation strictly before the safety checkpoint (its snapshot
    // must be the final pre-jump state), checkpoint strictly before the
    // restore, rewind announcement strictly after it succeeds.
    expect(cancelAgentTurnsMock).toHaveBeenCalledWith(WS);
    expect(notifyRewoundMock).toHaveBeenCalledWith(WS, {
      hash: "target1",
      subject: "Fix login",
    });
    expect(cancelAgentTurnsMock.mock.invocationCallOrder[0]).toBeLessThan(
      checkpointMock.mock.invocationCallOrder[0],
    );
    expect(checkpointMock.mock.invocationCallOrder[0]).toBeLessThan(
      restoreTreeMock.mock.invocationCallOrder[0],
    );
    expect(restoreTreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      notifyRewoundMock.mock.invocationCallOrder[0],
    );
    expect(refreshMetadataMock).toHaveBeenCalledWith(WS);
    // Surgical reconcile: no blanket content refetch on success.
    expect(contentRefetchMock).not.toHaveBeenCalled();
  });

  it("reconciles only the touched paths: re-reads loaded restored files, drops loaded deleted rows", async () => {
    restoreTreeMock.mockResolvedValue({
      restored: ["notes.md", "unopened.md"],
      deleted: ["old.md", "never-opened.md"],
    });
    // Only notes.md and old.md are loaded in the content collection.
    contentGetMock.mockImplementation((path: string) =>
      path === `${WS}/notes.md` || path === `${WS}/old.md`
        ? { path }
        : undefined,
    );
    readFilesMock.mockResolvedValue({
      succeeded: [{ path: `${WS}/notes.md`, content: "restored body" }],
      failed: [],
    });

    await jumpToCheckpoint(WS, {
      oid: "target-oid",
      hash: "target1",
      subject: "Fix login",
    });

    expect(contentWriteDeleteMock).toHaveBeenCalledWith([`${WS}/old.md`]);
    expect(readFilesMock).toHaveBeenCalledWith([`${WS}/notes.md`]);
    expect(contentWriteUpsertMock).toHaveBeenCalledWith([
      expect.objectContaining({
        path: `${WS}/notes.md`,
        content: "restored body",
        contentHash: expect.any(String),
      }),
    ]);
    expect(contentRefetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a full loaded-content refetch when the restore fails, and announces no rewind", async () => {
    restoreTreeMock.mockRejectedValueOnce(
      new GitError("CorruptRepository", "boom"),
    );

    await expect(
      jumpToCheckpoint(WS, {
        oid: "target-oid",
        hash: "target1",
        subject: "Fix login",
      }),
    ).rejects.toThrow("boom");

    expect(cancelAgentTurnsMock).toHaveBeenCalledWith(WS);
    expect(notifyRewoundMock).not.toHaveBeenCalled();
    expect(refreshMetadataMock).toHaveBeenCalledWith(WS);
    // Unknown partial state — the blanket refetch is the safe fallback.
    expect(contentRefetchMock).toHaveBeenCalled();
  });

  it("saveManualCheckpoint writes a user-role trailer message", async () => {
    checkpointMock.mockResolvedValue("oid-manual");

    const oid = await saveManualCheckpoint(WS, "renamed the chapters");

    expect(oid).toBe("oid-manual");
    const [, message] = checkpointMock.mock.calls[0];
    expect(message).toContain("renamed the chapters");
    expect(message).toContain("Notefig-Role: user");
  });
});
