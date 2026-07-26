/**
 * Caret placement applied by the editor focus resolver (editor-store) when
 * an arbiter intent for the editor carries one. Selection-only — the
 * resolver focuses afterwards. Intents without a placement leave the
 * selection untouched (mount restores its saved selection and must keep
 * it); flows that deliberately select-then-focus (goToLocation, i.e.
 * search results) bypass the arbiter entirely.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/**
 * The `before-node` placement: caret at the end of the nearest textblock
 * before the node (or the first one after it, for a leading widget) —
 * Escape out of an inline widget returns the cursor to where the user was
 * before summoning it. Placing explicitly also keeps ProseMirror's
 * focus-restore from re-painting whatever stale selection the doc held
 * (MET-93's jarring block highlight).
 */
export function placeCaretBeforeNode(editor: Editor, pos: number): void {
  const $before = editor.state.doc.resolve(
    Math.min(pos, editor.state.doc.content.size),
  );
  // between(), not near(): near() is inherited Selection.near, which happily
  // returns a leaf NodeSelection; between() seeks a textblock backward then
  // forward, so a leading widget still lands the caret in the block below.
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.between($before, $before, -1)),
  );
}
