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
  placeCaretAfterNode,
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

describe("placeCaretAfterNode", () => {
  it("puts the caret in the textblock after the node (escape-from-blob)", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Hi</p><img src='x.png'><p>there</p>",
    });
    // Park a stale range far away to prove it doesn't win.
    editor.commands.setTextSelection({ from: 1, to: 3 });

    placeCaretAfterNode(editor, 4, 1); // the image atom at pos 4
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(6); // start of "there"
  });

  it("falls back to the textblock before a trailing node", () => {
    editor = new Editor({
      extensions: editorExtensions,
      content: "<p>Hi</p><img src='x.png'>",
    });

    placeCaretAfterNode(editor, 4, 1);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(3); // end of "Hi"
  });
});
