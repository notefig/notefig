import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import {
  getEditorMarkdown,
  isExternalContentChange,
} from "@/components/editor/use-editor-file-sync";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("getEditorMarkdown", () => {
  it("serializes the current document", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "# Title\n\nBody text",
    });
    expect(getEditorMarkdown(editor)).toBe("# Title\n\nBody text");
  });
});

describe("isExternalContentChange", () => {
  it("is false for identical content", () => {
    expect(isExternalContentChange("# A\n\nB", "# A\n\nB")).toBe(false);
  });

  it("ignores trailing-newline-only differences (file convention)", () => {
    expect(isExternalContentChange("# A\n\nB", "# A\n\nB\n")).toBe(false);
    expect(isExternalContentChange("# A\n\nB\n", "# A\n\nB")).toBe(false);
  });

  it("is true for a real content difference", () => {
    expect(isExternalContentChange("# A\n\nB", "# A\n\nC")).toBe(true);
  });

  it("is true when the file was emptied", () => {
    expect(isExternalContentChange("# A", "")).toBe(true);
  });

  it("is false for two empty documents", () => {
    expect(isExternalContentChange("", "\n")).toBe(false);
  });
});
