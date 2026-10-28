/**
 * Diff blocks in the editor. A code block with a diff (./schema.ts) is drawn
 * as its card (./element.tsx), and is one thing to the selection, as the
 * prompt widget is:
 *
 * 1. Selected: a click on the card, an arrow onto it, or a selection that
 *    takes it in — the card wears the selection's tint. No selection end
 *    rests in its hidden source: one that would takes in the whole block,
 *    and one that would be all inside it selects the block. So a reference
 *    to a selection (the prompt widget's) holds the whole diff, or none.
 * 2. Editing: an explicit act — the card's Edit, or Enter on the selected
 *    block — shows the block as the code block it is (its highlighted
 *    source, the language picker) until the selection leaves it, or Escape
 *    selects it again.
 *
 * Presentation only: the markdown round-trip and history never hear of it.
 */
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createDiffBlockElement, WORKSPACE_ATTRIBUTE } from "./element";
import { parseDiffBlock } from "./patch";
import { DIFF_BLOCK_TAG } from "./syntax";

interface CodeDiffState {
  /** Where the diff block being edited starts, if one is. */
  editing: number | null;
  decorations: DecorationSet;
}

const key = new PluginKey<CodeDiffState>("codeDiff");

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Shows the source of the diff block at `pos`, the caret at its start. */
export function editDiffBlock(view: EditorView, pos: number): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)).setMeta(key, { editing: pos }));
  view.focus();
}

/** `workspacePath`: the workspace the document's diff paths are in. */
export function codeDiff({ workspacePath = null }: { workspacePath?: string | null } = {}): Plugin<CodeDiffState> {
  // An edit leaves every block it didn't touch the same node.
  const drawable = new WeakMap<PMNode, boolean>();
  const isDrawn = (node: PMNode) => {
    if (node.type.name !== "codeBlock" || node.attrs.diff !== true) return false;
    if (!drawable.has(node)) drawable.set(node, parseDiffBlock(node.attrs.language as string | null, node.textContent) !== null);
    return drawable.get(node)!;
  };
  const positions = new WeakMap<Element, () => number | undefined>();

  /** The drawn block a position is inside, if any. */
  const drawnAround = (state: EditorState, pos: number) => {
    const $pos = state.doc.resolve(pos);
    if ($pos.depth === 0 || !isDrawn($pos.parent)) return null;
    const from = $pos.before();
    return from === key.getState(state)?.editing ? null : { from, to: $pos.after() };
  };

  const draw = (node: PMNode) => (view: EditorView, getPos: () => number | undefined) => {
    const element = createDiffBlockElement(node.attrs.language as string | null, node.textContent);
    element.contentEditable = "false";
    if (workspacePath) element.setAttribute(WORKSPACE_ATTRIBUTE, workspacePath);
    positions.set(element, getPos);
    if (view.editable) {
      element.onEdit = () => {
        const at = getPos();
        if (at !== undefined) editDiffBlock(view, at);
      };
    }
    return element;
  };

  const decorate = (state: EditorState, editing: number | null) => {
    const { from, to, empty } = state.selection;
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "codeBlock") return !node.isTextblock;
      if (pos === editing || !isDrawn(node)) return false;
      const end = pos + node.nodeSize;
      // All of its source: rule 1 rests a selection's ends just inside it.
      const selected = !empty && from <= pos + 1 && to >= end - 1;
      decorations.push(
        Decoration.widget(pos, draw(node), {
          side: -1,
          // The same diff for the same source: a redraw only when it changes.
          key: `${node.attrs.language}\n${node.textContent}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
        Decoration.node(pos, end, { style: "display: none", ...(selected && { "data-diff-selected": "" }) }),
      );
      return false;
    });
    return DecorationSet.create(state.doc, decorations);
  };

  /** The card in this editor an event happened on, if any. */
  const cardAt = (view: EditorView, event: MouseEvent) =>
    event
      .composedPath()
      .find((target): target is Element => target instanceof Element && target.localName === DIFF_BLOCK_TAG && view.dom.contains(target)) ??
    null;

  /**
   * The selection a mouse gesture over cards means (rule 1), from the cards
   * it went down and came up on — not the DOM selection, which a browser
   * keeps out of a non-editable card (Chromium stops a drag at its edge).
   */
  const selectFromPointer = (view: EditorView, down: Element | null, up: Element | null, event: MouseEvent) => {
    if (!down && !up) return;
    const { state } = view;
    const posOf = (card: Element | null) => (card ? positions.get(card)?.() : undefined);
    if (down && down === up) {
      // A click, or a drag within it: the block.
      const at = posOf(down);
      if (at !== undefined) view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
      return;
    }
    // A drag between a card and the text: its end in a card is anywhere in
    // that block, which rule 1 then grows to take the block in.
    const from = posOf(down);
    const to = posOf(up);
    const anchor = from !== undefined ? from + 1 : state.selection.anchor;
    const head = to !== undefined ? to + 1 : view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    if (head === undefined) return;
    view.dispatch(state.tr.setSelection(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head))));
  };

  /** Rule 2: Enter on a selected block edits it. */
  const editSelected = (view: EditorView) => {
    const { selection } = view.state;
    if (!view.editable || !(selection instanceof NodeSelection) || !isDrawn(selection.node)) return false;
    editDiffBlock(view, selection.from);
    return true;
  };

  /** Rule 2: Escape selects the block being edited again. */
  const leaveEditing = (view: EditorView) => {
    const { state } = view;
    const editing = key.getState(state)?.editing ?? null;
    if (editing === null) return false;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, editing)).setMeta(key, { editing: null }));
    return true;
  };

  /** Rule 1: an arrow off the end of a line, onto a drawn block, selects
   *  it — the browser would skip it, its source being hidden. */
  const selectAcross = (view: EditorView, towards: "up" | "down" | "left" | "right") => {
    const { state } = view;
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty || selection.$head.depth === 0) return false;
    if (!view.endOfTextblock(towards)) return false;
    const forward = towards === "down" || towards === "right";
    const $edge = state.doc.resolve(forward ? selection.$head.after() : selection.$head.before());
    const next = forward ? $edge.nodeAfter : $edge.nodeBefore;
    if (!next || !isDrawn(next)) return false;
    const at = forward ? $edge.pos : $edge.pos - next.nodeSize;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)).scrollIntoView());
    return true;
  };

  return new Plugin<CodeDiffState>({
    key,
    state: {
      init: (_config, state): CodeDiffState => ({ editing: null, decorations: decorate(state, null) }),
      apply: (tr, previous, _old, state) => {
        const meta = tr.getMeta(key) as { editing: number | null } | undefined;
        let editing = meta ? meta.editing : previous.editing === null ? null : tr.mapping.map(previous.editing);
        if (editing !== null) {
          const node = state.doc.nodeAt(editing);
          const { from, to } = state.selection;
          const inside = node?.type.name === "codeBlock" && from > editing && to < editing + node.nodeSize;
          if (!inside) editing = null;
        }
        if (!tr.docChanged && !tr.selectionSet && editing === previous.editing) return previous;
        return { editing, decorations: decorate(state, editing) };
      },
    },

    // Rule 1: no selection end rests in a drawn block.
    appendTransaction: (_trs, _old, state) => {
      const { selection } = state;
      if (!(selection instanceof TextSelection)) return null;
      const anchorIn = drawnAround(state, selection.anchor);
      const headIn = drawnAround(state, selection.head);
      if (!anchorIn && !headIn) return null;
      if (anchorIn && headIn && anchorIn.from === headIn.from) {
        return state.tr.setSelection(NodeSelection.create(state.doc, anchorIn.from));
      }
      const forward = selection.head >= selection.anchor;
      const anchor = anchorIn ? (forward ? anchorIn.from + 1 : anchorIn.to - 1) : selection.anchor;
      const head = headIn ? (forward ? headIn.to - 1 : headIn.from + 1) : selection.head;
      if (anchor === selection.anchor && head === selection.head) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, anchor, head));
    },

    view: (view) => {
      let down: Element | null = null;
      const onMouseDown = (event: MouseEvent) => {
        down = event.button === 0 ? cardAt(view, event) : null;
      };
      const onMouseUp = (event: MouseEvent) => {
        const from = down;
        const to = cardAt(view, event);
        down = null;
        // Once ProseMirror has read the gesture's DOM selection, which it
        // does on this mouseup too, and would read over this.
        if (from || to) setTimeout(() => selectFromPointer(view, from, to, event));
      };
      // Capture: the card stops its events from reaching the editor.
      document.addEventListener("mousedown", onMouseDown, true);
      document.addEventListener("mouseup", onMouseUp, true);
      return {
        destroy: () => {
          document.removeEventListener("mousedown", onMouseDown, true);
          document.removeEventListener("mouseup", onMouseUp, true);
        },
      };
    },

    props: {
      decorations: (state) => key.getState(state)?.decorations,
      handleKeyDown: (view, event) => {
        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
        if (event.key === "Enter") return editSelected(view);
        if (event.key === "Escape") return leaveEditing(view);
        const towards = ARROWS[event.key];
        return towards ? selectAcross(view, towards) : false;
      },
    },
  });
}
