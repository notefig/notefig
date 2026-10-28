/**
 * Diff blocks in the editor. A code block with a diff (./schema.ts) is drawn
 * as one (./element.ts) while the selection is elsewhere, and shown as the
 * code block it is — its highlighted source, the language picker — once the
 * selection moves into it (a click on the diff moves it there), until it
 * leaves. A caret that is only left there — where a document opens, after
 * an edit elsewhere — draws it. Presentation only: the markdown round-trip
 * and history never hear of it.
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createDiffBlockElement, parseDiffBlock } from "./element";

interface CodeDiffState {
  /** Where the diff block being edited starts, if one is. */
  editing: number | null;
  decorations: DecorationSet;
}

const key = new PluginKey<CodeDiffState>("codeDiff");

const isDiff = (node: PMNode): boolean => node.type.name === "codeBlock" && node.attrs.diff === true;

function editingAt({ selection: { $from, $to } }: EditorState): number | null {
  return isDiff($from.parent) && $from.sameParent($to) ? $from.before() : null;
}

export function codeDiff(): Plugin<CodeDiffState> {
  // An edit leaves every block it didn't touch the same node.
  const drawable = new WeakMap<PMNode, boolean>();

  const draw = (node: PMNode) => (view: EditorView, getPos: () => number | undefined) => {
    const element = createDiffBlockElement(node.attrs.language as string | null, node.textContent);
    element.contentEditable = "false";
    element.addEventListener("click", () => {
      const at = getPos();
      // A drag that selected some of the diff is a copy, not a way in.
      if (!view.editable || at === undefined || document.getSelection()?.toString()) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1)));
      view.focus();
    });
    return element;
  };

  const decorate = (doc: PMNode, editing: number | null) => {
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "codeBlock") return !node.isTextblock;
      if (pos === editing || !isDiff(node)) return false;
      const language = node.attrs.language as string | null;
      if (!drawable.has(node)) drawable.set(node, parseDiffBlock(language, node.textContent) !== null);
      if (!drawable.get(node)) return false;
      decorations.push(
        Decoration.widget(pos, draw(node), {
          side: -1,
          // The same diff for the same source: a redraw only when it changes.
          key: `${language}\n${node.textContent}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
        Decoration.node(pos, pos + node.nodeSize, { style: "display: none" }),
      );
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };

  return new Plugin({
    key,
    state: {
      init: (_config, { doc }): CodeDiffState => ({ editing: null, decorations: decorate(doc, null) }),
      apply: (tr, previous, _old, state) => {
        const editing = tr.selectionSet || previous.editing !== null ? editingAt(state) : null;
        if (!tr.docChanged && editing === previous.editing) return previous;
        return { editing, decorations: decorate(state.doc, editing) };
      },
    },
    props: { decorations: (state) => key.getState(state)?.decorations },
  });
}
