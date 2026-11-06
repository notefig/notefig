/**
 * Marks a ProseMirror root as the owner of its own selection, for React.
 *
 * Before every commit React saves the focused contenteditable's selection as
 * character offsets, by walking every DOM node under it — O(document) on
 * each React commit anywhere in the app while an editor has focus. The
 * repo's react-dom patch (patches/react-dom+*.patch) skips that walk for an
 * element carrying this attribute: it keeps the selection's anchor nodes
 * instead, and on the rare commit that moves focus away (a re-parented
 * editor) it puts them back exactly when they are still inside the editor.
 * When they are not, ProseMirror restores its own selection on focus.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export const SELECTION_ANCHORS_ATTRIBUTE = "data-react-selection-anchors";

/**
 * Sets the attribute from a plugin, not `editorProps.attributes`: Tiptap
 * hands `editorProps` to `view.setProps` again on every `setOptions` (an
 * editable toggle), and an `attributes` there replaces the view's own —
 * Tiptap's `role="textbox"` with it. Plugin attributes are merged instead.
 */
export const SelectionAnchors = Extension.create({
  name: "selectionAnchors",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("selectionAnchors"),
        props: { attributes: { [SELECTION_ANCHORS_ATTRIBUTE]: "" } },
      }),
    ];
  },
});
