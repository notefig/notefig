import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";

const { getMarkdownEditor, getSelectedText, getWorkspaceEditorContext } =
  vi.hoisted(() => ({
    getMarkdownEditor: vi.fn(),
    getSelectedText: vi.fn(),
    getWorkspaceEditorContext: vi.fn(),
  }));
vi.mock("@/components/editor/editor-store", () => ({
  getMarkdownEditor,
  getSelectedText,
  getWorkspaceEditorContext,
}));

const { readWorkspaceTextFile } = vi.hoisted(() => ({
  readWorkspaceTextFile: vi.fn(async () => ""),
}));
vi.mock("@/utils/file-sync", () => ({ readWorkspaceTextFile }));

import { buildWidgetContextPayload } from "../widget-context-resource";

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

describe("buildWidgetContextPayload", () => {
  beforeEach(() => {
    getMarkdownEditor.mockReset();
    getSelectedText.mockReset();
    getWorkspaceEditorContext
      .mockReset()
      .mockReturnValue({ openFiles: [], activeFile: null });
    readWorkspaceTextFile.mockReset().mockResolvedValue("");
  });

  it("returns surroundingText centered on the given pos, live selection, and other open files", async () => {
    const editor = makeEditor(
      "# Intro\n\nSome body text right here.\n\n## Next\n\nmore text",
    );
    getMarkdownEditor.mockReturnValue(editor);
    getSelectedText.mockReturnValue("body text");
    getWorkspaceEditorContext.mockReturnValue({
      openFiles: [
        { path: "/ws/notes.md", active: true, dirty: false },
        { path: "/ws/other.md", active: false, dirty: true },
      ],
      activeFile: "/ws/notes.md",
    });

    const midPos = Math.floor(editor.state.doc.content.size / 3);
    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: midPos,
    });

    expect(payload.documentTitle).toBe("Intro");
    expect(payload.documentPath).toBe("notes.md");
    expect(payload.selectedText).toBe("body text");
    expect(payload.otherOpenFiles).toEqual([
      { path: "/ws/other.md", active: false, dirty: true },
    ]);
    expect(payload.surroundingText.length).toBeGreaterThan(0);
    expect(payload.outline).toEqual([
      { level: 1, text: "Intro" },
      { level: 2, text: "Next" },
    ]);
  });

  it("includes the full heading outline regardless of where pos sits", async () => {
    const editor = makeEditor("# A\n\nintro\n\n## B\n\nmid\n\n### C\n\nend");
    getMarkdownEditor.mockReturnValue(editor);
    getSelectedText.mockReturnValue(undefined);

    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: 0,
    });
    expect(payload.outline).toEqual([
      { level: 1, text: "A" },
      { level: 2, text: "B" },
      { level: 3, text: "C" },
    ]);
  });

  it("returns null selectedText when there is no live selection", async () => {
    const editor = makeEditor("plain text");
    getMarkdownEditor.mockReturnValue(editor);
    getSelectedText.mockReturnValue(undefined);

    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: 0,
    });
    expect(payload.selectedText).toBeNull();
  });

  it("falls back to basename for documentTitle when there's no heading", async () => {
    const editor = makeEditor("no heading here");
    getMarkdownEditor.mockReturnValue(editor);
    getSelectedText.mockReturnValue(undefined);

    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: 0,
    });
    expect(payload.documentTitle).toBe("notes.md");
  });

  it("returns a short/empty surroundingText and no heading for an empty doc", async () => {
    const editor = makeEditor("");
    getMarkdownEditor.mockReturnValue(editor);
    getSelectedText.mockReturnValue(undefined);

    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: 0,
    });
    expect(payload.surroundingText).toBe("");
    expect(payload.position.headingText).toBeNull();
  });

  it("falls back to reading disk content when no live editor is open", async () => {
    getMarkdownEditor.mockReturnValue(undefined);
    getSelectedText.mockReturnValue(undefined);
    readWorkspaceTextFile.mockResolvedValueOnce(
      "# Disk Title\n\nSome disk content.",
    );

    const payload = await buildWidgetContextPayload("/ws", {
      path: "notes.md",
      pos: 0,
    });
    expect(payload.documentTitle).toBe("Disk Title");
  });

  it("throws when the path escapes the workspace", async () => {
    await expect(
      buildWidgetContextPayload("/ws", { path: "../outside.md", pos: 0 }),
    ).rejects.toThrow();
  });
});
