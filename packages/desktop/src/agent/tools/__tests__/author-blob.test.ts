import { describe, it, expect, vi, beforeEach } from "vitest";

// Real blob-registry.ts globs .blob.tsx files — fragile as a test entry
// point (see acp-client's blob tests for the same rationale). Stub the
// surface author-blob.ts actually calls with a hand-rolled "schema" (no
// zod import needed inside vi.hoisted, which runs before module imports).
const { questionType } = vi.hoisted(() => ({
  questionType: {
    type: "question",
    schema: {
      safeParse: (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        if (typeof p?.prompt !== "string") {
          return { success: false, error: { message: "prompt is required" } };
        }
        return { success: true, data: p };
      },
    },
  },
}));
vi.mock("@/components/editor/blobs/blob-registry", () => ({
  getBlobType: (type: string) => (type === "question" ? questionType : undefined),
  getAllBlobTypes: () => [questionType],
}));

const { readWorkspaceTextFile, writeWorkspaceTextFile } = vi.hoisted(() => ({
  readWorkspaceTextFile: vi.fn(async (_path: string) => ""),
  writeWorkspaceTextFile: vi.fn(async (_path: string, _content: string) => {}),
}));
vi.mock("@/utils/file-sync", () => ({ readWorkspaceTextFile, writeWorkspaceTextFile }));

import { authorBlob } from "../author-blob";

const ctx = { workspacePath: "/ws", taskId: "task_1", agents: {} as never };

describe("authorBlob", () => {
  beforeEach(() => {
    readWorkspaceTextFile.mockReset().mockResolvedValue("");
    writeWorkspaceTextFile.mockReset().mockResolvedValue(undefined);
  });

  it("appends a well-formed fence to an empty document", async () => {
    const result = await authorBlob.execute(ctx, {
      path: "/ws/notes.md",
      type: "question",
      id: "question_8f2a",
      payload: { prompt: "Which tier?", options: ["Free", "Pro"] },
    });

    expect(result).toEqual({ ok: true, value: { blobId: "question_8f2a" } });
    expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
      "/ws/notes.md",
      expect.stringContaining("```notefig:question"),
    );
    const written = writeWorkspaceTextFile.mock.calls[0][1] as string;
    expect(written).toContain("id: question_8f2a");
    expect(written).toContain("prompt: Which tier?");
  });

  it("appends after existing content with a blank-line separator", async () => {
    readWorkspaceTextFile.mockResolvedValueOnce("# Doc\n\nSome text.\n");
    await authorBlob.execute(ctx, {
      path: "/ws/notes.md",
      type: "question",
      id: "question_9a1b",
      payload: { prompt: "OK?" },
    });
    const written = writeWorkspaceTextFile.mock.calls.at(-1)?.[1] as string;
    expect(written.startsWith("# Doc\n\nSome text.\n\n```notefig:question")).toBe(true);
  });

  it("rejects an unknown blob type", async () => {
    const result = await authorBlob.execute(ctx, {
      path: "/ws/notes.md",
      type: "poll",
      id: "poll_1234",
      payload: {},
    });
    expect(result).toEqual({
      ok: false,
      error: 'unknown blob type "poll". Known types: question',
    });
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();
  });

  it("rejects a payload that fails the type's schema", async () => {
    readWorkspaceTextFile.mockResolvedValueOnce("");
    const result = await authorBlob.execute(ctx, {
      path: "/ws/notes.md",
      type: "question",
      id: "question_bad1",
      payload: { options: ["A"] }, // missing required `prompt`
    });
    expect(result.ok).toBe(false);
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();
  });

  it("rejects a duplicate id already present in the document", async () => {
    readWorkspaceTextFile.mockResolvedValueOnce(
      "```notefig:question\nid: question_dupe\nprompt: Already here\n```\n",
    );
    const result = await authorBlob.execute(ctx, {
      path: "/ws/notes.md",
      type: "question",
      id: "question_dupe",
      payload: { prompt: "New one" },
    });
    expect(result).toEqual({
      ok: false,
      error: 'a block with id "question_dupe" already exists in /ws/notes.md',
    });
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();
  });
});
