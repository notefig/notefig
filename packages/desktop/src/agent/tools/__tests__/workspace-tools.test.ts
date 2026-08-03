import { describe, it, expect, vi } from "vitest";

vi.mock("@/entities/files", async (importOriginal) => ({
  // Real resolveEditablePath/loose-registry (pure, no fs) — only the
  // collection accessor is mocked.
  ...(await importOriginal<typeof import("@/entities/files")>()),
  getOrCreateWorkspaceCollections: vi.fn(() => ({
    metadata: {
      toArray: [
        { path: "/ws/notes.md", type: "file", contentHash: "" },
        { path: "/ws/chapters", type: "directory", contentHash: "" },
      ],
    },
  })),
}));

const { readWorkspaceTextFile } = vi.hoisted(() => ({
  readWorkspaceTextFile: vi.fn(async () => "file content"),
}));
vi.mock("@/utils/file-sync", () => ({ readWorkspaceTextFile }));

import { workspaceListDocuments } from "../workspace-list-documents";
import { workspaceReadDocument } from "../workspace-read-document";
import { workspaceOpenFiles } from "../workspace-open-files";

const ctx = { workspacePath: "/ws", taskId: "task_1", agents: {} as never };

describe("workspaceListDocuments", () => {
  it("maps metadata rows to {path, type, title}", async () => {
    const result = await workspaceListDocuments.execute(ctx, {});
    expect(result).toEqual({
      ok: true,
      value: [
        { path: "/ws/notes.md", type: "file", title: "notes.md" },
        { path: "/ws/chapters", type: "directory", title: "chapters" },
      ],
    });
  });
});

describe("workspaceReadDocument", () => {
  it("reads via readWorkspaceTextFile", async () => {
    const result = await workspaceReadDocument.execute(ctx, { path: "/ws/notes.md" });
    expect(result).toEqual({ ok: true, value: "file content" });
    expect(readWorkspaceTextFile).toHaveBeenCalledWith("/ws/notes.md", {
      line: undefined,
      limit: undefined,
    });
  });

  it("propagates read failures as a ToolResult error", async () => {
    readWorkspaceTextFile.mockRejectedValueOnce(new Error("not found"));
    const result = await workspaceReadDocument.execute(ctx, { path: "/ws/missing.md" });
    expect(result).toEqual({ ok: false, error: "not found" });
  });
});

describe("workspaceOpenFiles", () => {
  it("returns the current editor context", async () => {
    const result = await workspaceOpenFiles.execute(ctx, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        openFiles: [],
        activeFile: null,
        selection: undefined,
      });
    }
  });
});
