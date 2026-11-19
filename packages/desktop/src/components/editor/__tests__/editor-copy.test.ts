/** What a copy from the editor puts on the clipboard as plain text. */
import { afterEach, describe, expect, it } from "vitest";
import { type Content, Editor, getTextBetween, getTextSerializersFromSchema } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

/** The plain text tiptap writes for all of `markdown`, without this change. */
function tiptapText(markdown: string): string {
  const editor = new Editor({ extensions: editorExtensions, content: markdown });
  editors.push(editor);
  const { doc } = editor.state;
  return getTextBetween(doc, { from: 0, to: doc.content.size }, { textSerializers: getTextSerializersFromSchema(editor.schema) });
}

/** The plain text a copy of `from`–`to` in `markdown` writes. */
function copied(markdown: Content, from = 0, to?: number): string {
  const editor = new Editor({ extensions: editorExtensions, content: markdown });
  editors.push(editor);
  const end = to ?? editor.state.doc.content.size;
  // As a copy does: the selection's slice, with the selection where it is.
  editor.commands.setTextSelection({ from, to: end });
  return editor.view.serializeForClipboard(editor.state.selection.content()).text;
}

describe("copying", () => {
  it("writes a link's target in the plain text (MET-295)", () => {
    const markdown = "See [the docs](https://example.com/docs) here.";
    expect(copied(markdown, 1, 19)).toBe("See [the docs](https://example.com/docs) here.");
    // Part of a paragraph: the link the selection reaches into comes along.
    expect(copied(markdown, 5, 9)).toBe("[the ](https://example.com/docs)");
  });

  it("writes a link once when part of its text is bold", () => {
    expect(copied("[the **docs**](https://example.com/docs)", 1, 9)).toBe("[the docs](https://example.com/docs)");
  });

  it("writes a link whose text is its URL as the URL", () => {
    expect(copied("<https://example.com>", 1, 20)).toBe("https://example.com");
  });

  it("writes everything else as plain text, without markdown or escapes", () => {
    const blocks = "# Title\n\n- **one**\n- two\n\n> quote";
    expect(copied(blocks)).toBe(tiptapText(blocks));
    expect(copied(blocks)).not.toMatch(/[#*>-]/);
    expect(copied("2*3 and a < b", 1, 14)).toBe("2*3 and a < b");
    expect(copied("```js\nconst a_b = 2*3;\n```", 1, 17)).toBe("const a_b = 2*3;");
  });

  it("writes a prompt draft's text, which the file never holds", () => {
    const draft: Content = {
      type: "doc",
      content: [{ type: "aiPrompt", content: [{ type: "promptDraft", content: [{ type: "text", text: "fix the bug" }] }] }],
    };
    expect(copied(draft, 2, 13)).toBe("fix the bug");
  });
});
