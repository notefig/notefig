import { describe, it, expect, vi } from "vitest";

const readWorkspaceTextFile = vi.fn(
  async (_path: string, _options?: unknown) => "file content",
);

import { workspaceListDocuments } from "../workspace-list-documents";
import { workspaceReadDocument } from "../workspace-read-document";
import { workspaceOpenFiles } from "../workspace-open-files";
import { createTestCore, windowUrlState } from "@/testing/test-core";

// getWorkspaceEditorContext reads the layout through core.
createTestCore({ url: windowUrlState() });

const ctx = {
  workspacePath: "/ws",
  taskId: "task_1",
  agents: {} as never,
  // The workspace's listing and its documents, handed to the tools.
  services: {
    files: {
      collections: {
        metadata: {
          toArray: [
            { path: "/ws/notes.md", type: "file", contentHash: "" },
            { path: "/ws/chapters", type: "directory", contentHash: "" },
          ],
        },
      },
    },
    documents: { read: readWorkspaceTextFile },
  } as never,
};

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
