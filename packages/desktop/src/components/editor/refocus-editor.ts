/**
 * Caret placement applied by the editor focus resolver (editor-store) when
 * an arbiter intent for the editor wins. Selection-only — the resolver
 * focuses afterwards.
 *
 * Why placement happens before focus at all: ProseMirror re-paints whatever
 * selection the state last held when the editor regains focus, so a stale
 * range left behind by a search-result jump or a triple-click would
 * re-highlight a whole block the user never asked for (MET-93). Click-focus
 * is already protected by the mousedown handler in editor-store (it sets a
 * caret at the clicked position first); these are the equivalents for
 * arbiter-driven restores. Flows that deliberately select-then-focus
 * (goToLocation, i.e. search results) bypass the arbiter and keep their
 * range.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/** The default placement: collapse any non-caret selection to its head. */
export function collapseStaleSelection(editor: Editor): void {
  const { selection } = editor.state;
  if (!selection.empty) {
    editor.commands.setTextSelection(selection.head);
  }
}

/**
 * The `before-node` placement: caret at the end of the nearest textblock
 * before the node (or the first one after it, for a leading widget) —
 * Escape out of an inline widget returns the cursor to where the user was
 * before summoning it, not wherever the doc's stale selection happened to
 * sit and not past the widget.
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
