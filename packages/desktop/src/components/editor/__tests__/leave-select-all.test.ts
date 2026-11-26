/**
 * A selection of the whole document (⌘A) is left by an arrow key or a
 * click (MET-294). ProseMirror hands these to the browser when nothing lies
 * past the selection, and WebKit can't move a selection that ends between
 * the editor's own children, so in the app the document stayed selected
 * while the caret seemed to move. Chromium moves it, so here the editor's
 * own handling is checked: the key is taken, and where the caret lands.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { editorExtensions } from "../tiptap-editor-kit";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** A note that opens with a task list, the shape WebKit got stuck on, all
 *  selected. */
function selectedAll(): Editor {
  editor = new Editor({
    extensions: editorExtensions,
    content: '<ul data-type="taskList"><li data-type="taskItem"><p>Hello</p></li><li data-type="taskItem"><p>world</p></li></ul><p>Last.</p>',
  });
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  return editor;
}

/** `Mod` is ⌘ on a Mac and Ctrl elsewhere, as the keymap reads it. */
const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** Whether the editor's own key handling takes `key` (with Mod when `mod`). */
const press = (editor: Editor, key: string, mod = false) =>
  editor.view.someProp("handleKeyDown", (handle) =>
    handle(editor.view, new KeyboardEvent("keydown", { key, metaKey: mod && mac, ctrlKey: mod && !mac })),
  );

describe("leaving a select-all", () => {
  it.each([["ArrowRight"], ["ArrowDown"]])("collapses to the end on %s, with or without Mod", (key) => {
    for (const meta of [false, true]) {
      const e = selectedAll();
      expect(press(e, key, meta)).toBe(true);
      expect(e.state.selection.eq(TextSelection.atEnd(e.state.doc))).toBe(true);
      e.destroy();
    }
  });

  it.each([["ArrowLeft"], ["ArrowUp"]])("collapses to the start on %s, with or without Mod", (key) => {
    for (const meta of [false, true]) {
      const e = selectedAll();
      expect(press(e, key, meta)).toBe(true);
      expect(e.state.selection.eq(TextSelection.atStart(e.state.doc))).toBe(true);
      e.destroy();
    }
  });

  it("leaves an arrow key to the editor's usual handling when not all is selected", () => {
    const e = selectedAll();
    e.view.dispatch(e.state.tr.setSelection(TextSelection.atStart(e.state.doc)));
    expect(press(e, "ArrowRight")).toBeFalsy();
  });

  it("puts a caret where a press lands, and lets the press go on", () => {
    const e = selectedAll();
    const last = e.state.doc.content.size - 2;
    e.view.posAtCoords = () => ({ pos: last, inside: -1 });
    const down = new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10 });
    const taken = e.view.someProp("handleDOMEvents", (events) => events.mousedown?.(e.view, down));
    expect(taken).toBeFalsy();
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.from).toBe(last);
    // Shift extends a selection: the select-all stays.
    const again = selectedAll();
    again.view.someProp("handleDOMEvents", (events) => events.mousedown?.(again.view, new MouseEvent("mousedown", { button: 0, shiftKey: true })));
    expect(again.state.selection).toBeInstanceOf(AllSelection);
  });
});
