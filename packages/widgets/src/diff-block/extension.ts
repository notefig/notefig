/**
 * Diff blocks in the editor. A code block with a diff (./schema.ts) is drawn
 * as its card (./element.tsx), and is one thing to the selection, as the
 * prompt widget is:
 *
 * 1. Selected: a click on the card, an arrow onto it, or a selection that
 *    takes it in — the card wears the selection's tint. Selected alone,
 *    the keys are on it: its controls show their digits, and a digit runs
 *    one, as the prompt widget's choices do. No selection end
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
import type { Mappable } from "@tiptap/pm/transform";
import type { FileDiffMetadata } from "@pierre/diffs";
import { createDiffBlockElement, WORKSPACE_ATTRIBUTE, type DiffBlockElement } from "./element";
import { parseDiffBlock } from "./patch";
import "./extension.css";

/** A code block with a diff: where it is, and its diff as Pierre reads it
 *  — null when it has none, and stays code. */
interface DiffBlock {
  from: number;
  to: number;
  node: PMNode;
  diff: FileDiffMetadata | null;
}

/**
 * What every rule below reads: the document's diff blocks, found in one walk
 * when the document changes and kept as they are while only the selection
 * moves. A diff is read once per block: an unchanged block is the same node,
 * and keeps the diff it had. Nothing outlives the document — a removed
 * block's diff goes with it, not kept for the undo history to hold.
 */
interface CodeDiffState {
  blocks: readonly DiffBlock[];
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

/** The document's diff blocks, in order, reusing the diffs of `previous`
 *  that are still in it. */
function scan(doc: PMNode, previous: readonly DiffBlock[]): DiffBlock[] {
  const known = new Map(previous.map((block) => [block.node, block.diff]));
  const blocks: DiffBlock[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return !node.isTextblock;
    if (node.attrs.diff === true) {
      const diff = known.has(node)
        ? (known.get(node) ?? null)
        : parseDiffBlock(node.attrs.language as string | null, node.textContent);
      blocks.push({ from: pos, to: pos + node.nodeSize, node, diff });
    }
    return false;
  });
  return blocks;
}

/** The block `pos` is at or in, if any: a binary search, as blocks never
 *  hold one another. */
function blockAt(blocks: readonly DiffBlock[], pos: number): DiffBlock | null {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const block = blocks[middle];
    if (pos < block.from) high = middle - 1;
    else if (pos >= block.to) low = middle + 1;
    else return block;
  }
  return null;
}

/** The blocks a range takes in any of, in order. */
function* blocksIn(blocks: readonly DiffBlock[], from: number, to: number): Generator<DiffBlock> {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].to <= from) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < blocks.length && blocks[index].from < to; index++) yield blocks[index];
}

/** Whether a change only moved the blocks, their cards with them: the same
 *  blocks, each card (a widget before its block) mapped to where its block
 *  now starts. Not so when something went in at a block's start: the card
 *  stays before it. */
const cardsMoved = (previous: readonly DiffBlock[], blocks: readonly DiffBlock[], mapping: Mappable) =>
  previous.length === blocks.length &&
  previous.every((block, index) => block.node === blocks[index].node && mapping.map(block.from, -1) === blocks[index].from);

/** The drawn block that starts at `pos`, if one does. */
function drawnFrom(state: EditorState, pos: number): DiffBlock | null {
  const block = blockAt(key.getState(state)!.blocks, pos);
  return block?.from === pos && block.diff ? block : null;
}

/** Shows the source of the diff block at `pos`, the caret at its start. */
export function editDiffBlock(view: EditorView, pos: number): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)).setMeta(key, { editing: pos }));
  view.focus();
}

/** `workspacePath`: the workspace the document's diff paths are in. */
export function codeDiff({ workspacePath = null }: { workspacePath?: string | null } = {}): Plugin<CodeDiffState> {
  /** This editor's drawn cards, each with where its block is (for the
   *  pointer): the card's widget adds it, and removes it when it is gone. */
  const cards = new Map<DiffBlockElement, () => number | undefined>();

  /** The drawn block a position is inside, if any. */
  const drawnAround = (state: EditorState, pos: number) => {
    const { blocks, editing } = key.getState(state)!;
    const block = blockAt(blocks, pos);
    return block?.diff && pos > block.from && block.from !== editing ? block : null;
  };

  const draw = ({ node, diff }: DiffBlock) => (view: EditorView, getPos: () => number | undefined) => {
    const element = createDiffBlockElement(node.attrs.language as string | null, node.textContent, diff ?? undefined);
    element.contentEditable = "false";
    // What ./extension.css hides the source after: an editor's card, not a
    // rendered reply's (a widget response's) element, whose next block is
    // its own.
    element.setAttribute("data-source-after", "");
    cards.set(element, getPos);
    if (view.editable) {
      element.onEdit = () => {
        const at = getPos();
        if (at !== undefined) editDiffBlock(view, at);
      };
    }
    return element;
  };

  const decorate = (doc: PMNode, blocks: readonly DiffBlock[], editing: number | null) =>
    DecorationSet.create(
      doc,
      blocks.flatMap((block) => {
        if (!block.diff || block.from === editing) return [];
        // The card alone: a stylesheet hides the source after it
        // (./extension.css), as a node decoration per block would make every
        // update of a long document look at each of its blocks for them.
        return [
          Decoration.widget(block.from, draw(block), {
            side: -1,
            // The same diff for the same source: a redraw only when it changes.
            key: `${block.node.attrs.language}\n${block.node.textContent}`,
            ignoreSelection: true,
            stopEvent: () => true,
            destroy: (element) => cards.delete(element as DiffBlockElement),
          }),
        ];
      }),
    );

  /** The card in this editor an event happened on, if any. */
  const cardAt = (event: MouseEvent) =>
    event
      .composedPath()
      .find((target): target is DiffBlockElement => target instanceof Element && cards.has(target as DiffBlockElement)) ??
    null;

  /**
   * The selection a mouse gesture over cards means (rule 1), from the cards
   * it went down and came up on — not the DOM selection, which a browser
   * keeps out of a non-editable card (Chromium stops a drag at its edge).
   */
  const selectFromPointer = (view: EditorView, down: DiffBlockElement | null, up: DiffBlockElement | null, event: MouseEvent) => {
    if (!down && !up) return;
    const { state } = view;
    const posOf = (card: DiffBlockElement | null) => (card ? cards.get(card)?.() : undefined);
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

  /** The card drawing a block: its widget sits just before the block's
   *  (hidden) source. */
  const cardOf = (view: EditorView, block: DiffBlock) => {
    const card = view.nodeDOM(block.from)?.previousSibling as DiffBlockElement | null | undefined;
    return card && cards.has(card) ? card : null;
  };

  /** The cards a selection takes the blocks of in, each with whether the
   *  keys are on it: whether its block is the one selected. */
  const cardsTakenIn = (view: EditorView, blocks: readonly DiffBlock[]) => {
    const { selection } = view.state;
    const taken = new Map<DiffBlockElement, boolean>();
    if (selection.empty) return taken;
    for (const block of blocksIn(blocks, selection.from, selection.to)) {
      // All of its source: rule 1 rests a selection's ends just inside it.
      const takenIn = selection.from <= block.from + 1 && selection.to >= block.to - 1;
      const card = takenIn && block.diff ? cardOf(view, block) : null;
      if (card) taken.set(card, selection instanceof NodeSelection && selection.from === block.from);
    }
    return taken;
  };

  /** The cards wearing the tint, each with whether the keys are on it. */
  let marked = new Map<DiffBlockElement, boolean>();

  /** Rule 1's look: a card wears the tint while a selection takes its
   *  block in, and the keys are on it while it is the block selected. Only
   *  the cards the selection takes in are looked at, and only when it or
   *  the blocks change. */
  const markSelection = (view: EditorView, previous?: EditorState) => {
    const { blocks } = key.getState(view.state)!;
    if (previous?.selection.eq(view.state.selection) && key.getState(previous)!.blocks === blocks) return;
    const marking = cardsTakenIn(view, blocks);
    for (const card of marked.keys()) {
      if (marking.has(card)) continue;
      card.removeAttribute("data-selected");
      card.keys = false;
    }
    for (const [card, keys] of marking) {
      card.setAttribute("data-selected", "");
      card.keys = keys;
    }
    marked = marking;
  };

  /** A digit on the selected block runs its card's control. */
  const runControl = (view: EditorView, index: number) => {
    const { selection } = view.state;
    if (!(selection instanceof NodeSelection)) return false;
    const block = drawnFrom(view.state, selection.from);
    const card = block && cardOf(view, block);
    return card ? card.runControl(index) : false;
  };

  /** Rule 2: Enter on a selected block edits it. */
  const editSelected = (view: EditorView) => {
    const { selection } = view.state;
    if (!view.editable || !(selection instanceof NodeSelection) || !drawnFrom(view.state, selection.from)) return false;
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
    if (!next) return false;
    const at = forward ? $edge.pos : $edge.pos - next.nodeSize;
    if (!drawnFrom(state, at)) return false;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)).scrollIntoView());
    return true;
  };

  return new Plugin<CodeDiffState>({
    key,
    state: {
      init: (_config, state): CodeDiffState => {
        const blocks = scan(state.doc, []);
        return { blocks, editing: null, decorations: decorate(state.doc, blocks, null) };
      },
      apply: (tr, previous, _old, state) => {
        const blocks = tr.docChanged ? scan(state.doc, previous.blocks) : previous.blocks;
        const meta = tr.getMeta(key) as { editing: number | null } | undefined;
        let editing = meta ? meta.editing : previous.editing === null ? null : tr.mapping.map(previous.editing);
        if (editing !== null) {
          const block = blockAt(blocks, editing);
          const { from, to } = state.selection;
          if (block?.from !== editing || from <= block.from || to >= block.to) editing = null;
        }
        if (blocks === previous.blocks && editing === previous.editing) return previous;
        const decorations =
          editing === previous.editing && cardsMoved(previous.blocks, blocks, tr.mapping)
            ? previous.decorations.map(tr.mapping, tr.doc)
            : decorate(state.doc, blocks, editing);
        return { blocks, editing, decorations };
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
      let down: DiffBlockElement | null = null;
      const onMouseDown = (event: MouseEvent) => {
        down = event.button === 0 ? cardAt(event) : null;
      };
      const onMouseUp = (event: MouseEvent) => {
        const from = down;
        const to = cardAt(event);
        down = null;
        // Once ProseMirror has read the gesture's DOM selection, which it
        // does on this mouseup too, and would read over this.
        if (from || to) setTimeout(() => selectFromPointer(view, from, to, event));
      };
      // Capture: the card stops its events from reaching the editor.
      document.addEventListener("mousedown", onMouseDown, true);
      document.addEventListener("mouseup", onMouseUp, true);
      markSelection(view);
      return {
        update: markSelection,
        destroy: () => {
          document.removeEventListener("mousedown", onMouseDown, true);
          document.removeEventListener("mouseup", onMouseUp, true);
        },
      };
    },

    props: {
      // The document's workspace, for every diff in it — the cards above
      // and those in its widgets' responses alike.
      attributes: workspacePath ? { [WORKSPACE_ATTRIBUTE]: workspacePath } : {},
      decorations: (state) => key.getState(state)?.decorations,
      handleKeyDown: (view, event) => {
        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
        if (event.key === "Enter") return editSelected(view);
        if (event.key === "Escape") return leaveEditing(view);
        if (/^[1-9]$/.test(event.key)) return runControl(view, Number(event.key) - 1);
        const towards = ARROWS[event.key];
        return towards ? selectAcross(view, towards) : false;
      },
    },
  });
}
