/**
 * Caret placement applied by the editor focus resolver before focusing
 * (MET-93): Escape out of a blob must land the caret next to the blob, not
 * wherever the doc's stale selection sat (which would re-highlight a block).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { placeCaretBeforeNode } from "@/components/editor/refocus-editor";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("placeCaretBeforeNode", () => {
  it("puts the caret at the end of the textblock before the node (escape-from-blob)", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Hi</p><img src='x.png'><p>there</p>",
    });
    // Park a stale range elsewhere to prove it doesn't win.
    editor.commands.setTextSelection({ from: 7, to: 10 });

    placeCaretBeforeNode(editor, 4); // the image atom at pos 4
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(3); // end of "Hi"
  });

  it("falls forward to the next textblock for a leading node", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<img src='x.png'><p>there</p>",
    });

    placeCaretBeforeNode(editor, 0);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(2); // start of "there"
  });
});
