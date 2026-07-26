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
 * The `after-node` placement: caret in the nearest textblock after the node
 * (or before, when it's the last node) — Escape out of an inline widget
 * lands where the user just was, not wherever the doc's stale selection
 * happened to sit.
 */
export function placeCaretAfterNode(
  editor: Editor,
  pos: number,
  nodeSize: number,
): void {
  const $after = editor.state.doc.resolve(
    Math.min(pos + nodeSize, editor.state.doc.content.size),
  );
  // between(), not near(): near() is inherited Selection.near, which happily
  // returns a leaf NodeSelection; between() seeks a textblock forward then
  // backward, so a trailing widget still lands the caret in the block above.
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.between($after, $after, 1)),
  );
}
