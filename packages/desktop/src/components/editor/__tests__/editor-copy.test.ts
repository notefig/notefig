/** What a copy from the editor puts on the clipboard as plain text. */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

/** The plain text a copy of `from`–`to` in `markdown` writes. */
function copied(markdown: string, from = 0, to?: number): string {
  const editor = new Editor({ extensions: editorExtensions, content: markdown });
  editors.push(editor);
  const end = to ?? editor.state.doc.content.size;
  // As a copy does: the selection's slice, with the selection where it is.
  editor.commands.setTextSelection({ from, to: end });
  return editor.view.serializeForClipboard(editor.state.doc.slice(from, end)).text;
}

describe("copying", () => {
  it("writes a link's target in the plain text (MET-295)", () => {
    const markdown = "See [the docs](https://example.com/docs) here.";
    expect(copied(markdown, 1, 19)).toBe("See [the docs](https://example.com/docs) here.");
    // Part of a paragraph: the link the selection reaches into comes along.
    expect(copied(markdown, 5, 9)).toBe("[the ](https://example.com/docs)");
  });

  it("writes text from inside a code block as it reads", () => {
    expect(copied("```js\nconst a_b = 2*3;\n```", 1, 17)).toBe("const a_b = 2*3;");
  });

  it("writes blocks as markdown", () => {
    expect(copied("# Title\n\n- **one**\n- two")).toBe("# Title\n\n- **one**\n- two");
  });
});
