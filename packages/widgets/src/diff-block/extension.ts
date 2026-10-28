/**
 * Diff blocks in the editor. A code block whose language is `diff:…`
 * (./syntax.ts) is drawn as its diff (./view.ts) while the selection is
 * elsewhere, and shown as the code block it is — its source, the language
 * picker — once the selection moves into it (a click on the diff moves it
 * there), until it leaves. A caret that is only left there — where a
 * document opens, after an edit elsewhere — draws it. Presentation only:
 * the node stays a codeBlock, so the markdown round-trip and history never
 * hear of diffs.
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isDiffLanguage, parseDiffBlock, type DiffBlock } from "./syntax";
import { mountDiffView } from "./view";

interface CodeDiffState {
  /** Where the diff block being edited starts, if one is. */
  editing: number | null;
  decorations: DecorationSet;
}

const key = new PluginKey<CodeDiffState>("codeDiff");

function editingAt({ selection: { $from, $to } }: EditorState): number | null {
  const block = $from.parent;
  if (block.type.name !== "codeBlock" || !isDiffLanguage(block.attrs.language as string | null)) return null;
  return $from.sameParent($to) ? $from.before() : null;
}

export function codeDiff(): Plugin<CodeDiffState> {
  // An edit leaves every block it didn't touch the same node.
  const parsed = new WeakMap<PMNode, DiffBlock | null>();
  const destroys = new WeakMap<Node, () => void>();

  const draw = (block: DiffBlock) => (view: EditorView, getPos: () => number | undefined) => {
    const { host, destroy } = mountDiffView(block);
    destroys.set(host, destroy);
    host.contentEditable = "false";
    host.addEventListener("click", () => {
      const at = getPos();
      // A drag that selected some of the diff is a copy, not a way in.
      if (!view.editable || at === undefined || document.getSelection()?.toString()) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1)));
      view.focus();
    });
    return host;
  };

  const decorate = (doc: PMNode, editing: number | null) => {
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "codeBlock") return !node.isTextblock;
      const language = node.attrs.language as string | null;
      if (pos === editing || !isDiffLanguage(language)) return false;
      if (!parsed.has(node)) parsed.set(node, parseDiffBlock(language, node.textContent));
      const block = parsed.get(node);
      if (!block) return false;
      decorations.push(
        Decoration.widget(pos, draw(block), {
          side: -1,
          // The same diff for the same source: a redraw only when it changes.
          key: `${language}\n${node.textContent}`,
          ignoreSelection: true,
          stopEvent: () => true,
          destroy: (host) => destroys.get(host)?.(),
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
      init: (_config, { doc }) => ({ editing: null, decorations: decorate(doc, null) }),
      apply: (tr, previous, _old, state) => {
        const editing = tr.selectionSet || previous.editing !== null ? editingAt(state) : null;
        if (!tr.docChanged && editing === previous.editing) return previous;
        return { editing, decorations: decorate(state.doc, editing) };
      },
    },
    props: { decorations: (state) => key.getState(state)?.decorations },
  });
}
