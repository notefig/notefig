/**
 * Caret placement applied by the editor focus resolver before focusing
 * (MET-93): a stale range left by a search jump or triple-click must not
 * re-highlight a block when the widget/sidebar hands focus back, and
 * Escape out of a blob must land the caret next to the blob.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import {
  collapseStaleSelection,
  placeCaretBeforeNode,
} from "@/components/editor/refocus-editor";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("collapseStaleSelection", () => {
  it("collapses a stale range selection to its head", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Some paragraph of text</p>",
    });
    editor.commands.setTextSelection({ from: 2, to: 10 });
    expect(editor.state.selection.empty).toBe(false);

    collapseStaleSelection(editor);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(10);
  });

  it("collapses a node selection", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Hi</p><img src='x.png'><p>there</p>",
    });
    const imagePos = 4; // after the "Hi" paragraph (0..4)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, imagePos),
      ),
    );
    expect(editor.state.selection instanceof NodeSelection).toBe(true);

    collapseStaleSelection(editor);
    expect(editor.state.selection.empty).toBe(true);
  });

  it("leaves a caret selection where it is", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Some paragraph of text</p>",
    });
    editor.commands.setTextSelection(7);

    collapseStaleSelection(editor);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(7);
  });
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
