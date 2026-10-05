/**
 * The range-read tool (doc references): same doc resolution and coordinate
 * space as the widget-context resource, which is the contract the agent
 * relies on — `selectedRange` from the payload must be valid input here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";

const { getMarkdownEditor, getSelectedText } = vi.hoisted(() => ({
  getMarkdownEditor: vi.fn(),
  getSelectedText: vi.fn(),
}));
vi.mock("@/entities/editors", () => ({
  getMarkdownEditor,
  getSelectedText,
  getWorkspaceEditorContext: vi.fn(() => ({ openFiles: [], activeFile: null })),
}));

const { readWorkspaceTextFile } = vi.hoisted(() => ({
  readWorkspaceTextFile: vi.fn(async () => ""),
}));
vi.mock("@/utils/file-sync", () => ({ readWorkspaceTextFile }));

import { documentReadRange } from "../document-read-range";

const ctx = {
  workspacePath: "/ws",
  taskId: "task_1",
  agents: {} as never,
  services: {} as never,
};

const editors: Editor[] = [];
function makeEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: editorExtensions,
    content: markdown,
    editable: true,
    autofocus: false,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors.length = 0;
});

describe("documentReadRange", () => {
  beforeEach(() => {
    getMarkdownEditor.mockReset();
    readWorkspaceTextFile.mockReset().mockResolvedValue("");
  });

  it("reads a live editor's content between two ProseMirror positions", async () => {
    const editor = makeEditor("Hello wide world");
    getMarkdownEditor.mockReturnValue(editor);
    // The exact range a summon-over-selection would have captured.
    const { from, to } = { from: 7, to: 11 };
    expect(editor.state.doc.textBetween(from, to, "\n")).toBe("wide");
    const result = await documentReadRange.execute(ctx, {
      path: "doc.md",
      from,
      to,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        content: "wide",
        from,
        to,
        docSize: editor.state.doc.content.size,
      },
    });
  });

  it("falls back to parsing disk content when no editor is open", async () => {
    getMarkdownEditor.mockReturnValue(undefined);
    readWorkspaceTextFile.mockResolvedValue("On disk only");
    const result = await documentReadRange.execute(ctx, {
      path: "doc.md",
      from: 0,
      to: 999,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("On disk only");
  });

  it("clamps an out-of-bounds range and echoes the effective one", async () => {
    const editor = makeEditor("Short");
    getMarkdownEditor.mockReturnValue(editor);
    const docSize = editor.state.doc.content.size;
    const result = await documentReadRange.execute(ctx, {
      path: "doc.md",
      from: 3,
      to: docSize + 500,
    });
    expect(result).toEqual({
      ok: true,
      value: { content: "ort", from: 3, to: docSize, docSize },
    });
  });

  it("rejects a path escaping the workspace", async () => {
    const result = await documentReadRange.execute(ctx, {
      path: "../outside.md",
      from: 0,
      to: 5,
    });
    expect(result.ok).toBe(false);
  });
});
