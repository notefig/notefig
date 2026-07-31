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

describe("external-content adoption keeps undo history intact", () => {
  // Regression for a real repro: an agent writes a file to disk while the
  // user has it open, the "disk → editor" adoption effect replaces the
  // whole document (use-editor-file-sync.ts), and the user then types "/"
  // to summon a prompt widget. A plain `editor.commands.setContent(...)`
  // for the adoption becomes an ordinary undo step with no meaningful
  // "before" position — undoing the summon afterward walked straight
  // through the adoption too, dropping the cursor at the start of the doc
  // instead of just reverting the summon. `addToHistory: false` on the
  // adoption's transaction (via `.chain().setMeta(...).setContent(...)`,
  // the exact pattern used in use-editor-file-sync.ts) keeps it out of the
  // undo stack entirely, so undoing a later edit only ever targets that
  // edit.
  it("undoing an edit made after adoption doesn't also undo the adoption", async () => {
    editor = new Editor({ extensions: editorExtensions, content: "<p>placeholder</p>" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent("<h1>Title</h1><p>Intro.</p>", { emitUpdate: false })
      .run();

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("!");
    expect(getEditorMarkdown(editor)).toBe("# Title\n\nIntro.!");

    editor.commands.undo();

    expect(getEditorMarkdown(editor)).toBe("# Title\n\nIntro.");
  });
});
