/**
 * A transaction that changes nothing never reaches the view: Tiptap's
 * `commands.x()` dispatches even when x declines, and each such dispatch
 * was a whole view update in a long document.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function transactionsOf(run: (editor: Editor) => void): number {
  editor = new Editor({ extensions: editorExtensions, content: "<p>Text</p>" });
  let count = 0;
  editor.on("transaction", () => count++);
  run(editor);
  return count;
}

describe("SkipEmptyTransactions", () => {
  it("drops a declined command's transaction", () => {
    expect(transactionsOf((e) => e.commands.command(() => false))).toBe(0);
  });

  it("keeps edits, selection moves, scrolls and metas", () => {
    expect(transactionsOf((e) => e.commands.insertContentAt(1, "x"))).toBe(1);
    expect(transactionsOf((e) => e.commands.setTextSelection(2))).toBe(1);
    expect(transactionsOf((e) => e.view.dispatch(e.state.tr.scrollIntoView()))).toBe(1);
    expect(transactionsOf((e) => e.view.dispatch(e.state.tr.setMeta("refresh", true)))).toBe(1);
  });
});
