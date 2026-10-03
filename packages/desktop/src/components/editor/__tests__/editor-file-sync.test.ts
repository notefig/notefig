import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { DocumentSync } from "@/utils/markdown-conversion";
import { calculateContentHash } from "@/utils/hash";

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

describe("DocumentSync.needsAdoption", () => {
  const baselined = (content: string) => {
    const sync = new DocumentSync("/ws/doc.md");
    sync.ensureBaseline(content, calculateContentHash(content));
    return sync;
  };
  const needsAdoption = (sync: DocumentSync, fileContent: string) =>
    sync.needsAdoption(calculateContentHash(fileContent), fileContent);

  it("is false before a baseline exists (content still loading)", () => {
    expect(needsAdoption(new DocumentSync("/ws/doc.md"), "# A")).toBe(false);
  });

  it("is false for identical content", () => {
    expect(needsAdoption(baselined("# A\n\nB"), "# A\n\nB")).toBe(false);
  });

  it("ignores trailing-newline-only differences (file convention)", () => {
    expect(needsAdoption(baselined("# A\n\nB"), "# A\n\nB\n")).toBe(false);
    expect(needsAdoption(baselined("# A\n\nB\n"), "# A\n\nB")).toBe(false);
  });

  it("is true for a real content difference", () => {
    expect(needsAdoption(baselined("# A\n\nB"), "# A\n\nC")).toBe(true);
  });

  it("is true when the file was emptied", () => {
    expect(needsAdoption(baselined("# A"), "")).toBe(true);
  });
});
