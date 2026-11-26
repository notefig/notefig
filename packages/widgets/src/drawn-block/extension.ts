/**
 * Drawn code blocks in the editor: a code block of a kind that draws it — a
 * diff (../diff-block/extension.ts), a diagram — is shown as its card, and
 * is one thing to the selection, as the prompt widget is:
 *
 * 1. Selected: an arrow onto it, Backspace or Delete from the line beside
 *    it, or a selection that takes it in — the card wears the selection's
 *    tint. Never a click: a click or a drag in the card is the reader's, to
 *    select what it shows. Selected alone,
 *    the keys are on it: its controls show their digits, and a digit runs
 *    one, as the prompt widget's choices do. No selection end
 *    rests in its hidden source: one that would takes in the whole block,
 *    and one that would be all inside it selects the block. So a reference
 *    to a selection (the prompt widget's) holds the whole block, or none.
 * 2. Editing: an explicit act — the card's Edit, or Enter on the selected
 *    block — shows the block as the code block it is (its highlighted
 *    source, the language picker) until the selection leaves it, or Escape
 *    selects it again.
 *
 * One plugin for every kind: one walk of the document finds them all, and
 * the rules above are the same for each. Presentation only: the markdown
 * round-trip and history never hear of it.
 */
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Mappable } from "@tiptap/pm/transform";
import { eachCodeBlock, touchesCode } from "../code-blocks";
import "./extension.css";

/** A card the editor draws a block with; the editor hands it a way into the
 *  block's source, and says when the keys are on it. */
export interface DrawnBlockElement extends HTMLElement {
  onEdit?: () => void;
  /** The keys are on the card: its controls show their digits. */
  keys: boolean;
  /** Runs the card's `index`th control; false when it has none there, or
   *  isn't drawn. */
  runControl(index: number): boolean;
}

/** A kind of code block the editor draws: which blocks are its, what it
 *  reads from one (once per block), and the card it draws from that. Its
 *  methods are methods, so a kind of any `T` is a `DrawnBlockKind`. */
export interface DrawnBlockKind<T = unknown> {
  name: string;
  matches(node: PMNode): boolean;
  /** Null: the block stays the code it is. */
  read(node: PMNode): T | null;
  draw(node: PMNode, value: T): DrawnBlockElement;
  /** Attributes the document's element wears for this kind's cards. */
  attributes?: Record<string, string>;
}

/** A block of one of the kinds: where it is, and what its kind read from it
 *  — null when that was nothing, and it stays code. */
interface DrawnBlock {
  from: number;
  to: number;
  node: PMNode;
  kind: DrawnBlockKind;
  value: unknown;
}

/**
 * What every rule below reads: the document's drawn blocks, found in one walk
 * when the document changes and kept as they are while only the selection
 * moves. A block is read once: an unchanged block is the same node, and
 * keeps what it had. Nothing outlives the document — a removed block's value
 * goes with it, not kept for the undo history to hold.
 */
interface DrawnBlocksState {
  blocks: readonly DrawnBlock[];
  /** Where the block being edited starts, if one is. */
  editing: number | null;
  decorations: DecorationSet;
}

const key = new PluginKey<DrawnBlocksState>("drawnCodeBlocks");

const DELETES: Record<string, "back" | "forward"> = { Backspace: "back", Delete: "forward" };

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The document's drawn blocks, in order, reusing the values of `previous`
 *  that are still in it. */
function scan(doc: PMNode, kinds: readonly DrawnBlockKind[], previous: readonly DrawnBlock[]): DrawnBlock[] {
  const known = new Map(previous.map((block) => [block.node, block]));
  const blocks: DrawnBlock[] = [];
  eachCodeBlock(doc, (node, pos) => {
    const before = known.get(node);
    const kind = before?.kind ?? kinds.find((candidate) => candidate.matches(node));
    if (!kind) return;
    const value = before ? before.value : kind.read(node);
    blocks.push({ from: pos, to: pos + node.nodeSize, node, kind, value });
  });
  return blocks;
}

/** The blocks where an edit that touched no code block moved them — most
 *  typing, which walking the document for cost ~0.3 ms a keystroke in an
 *  8,000-line one. Null when it may have changed one: scan again. */
function moved(tr: Transaction, blocks: readonly DrawnBlock[]): readonly DrawnBlock[] | null {
  if (touchesCode(tr)) return null;
  if (blocks.length === 0) return blocks;
  const next = blocks.map((block) => ({ ...block, from: tr.mapping.map(block.from, 1), to: tr.mapping.map(block.to, -1) }));
  return next.every((block) => tr.doc.nodeAt(block.from) === block.node) ? next : null;
}

/** The document's drawn blocks after `tr`. */
function blocksAfter(tr: Transaction, kinds: readonly DrawnBlockKind[], blocks: readonly DrawnBlock[]): readonly DrawnBlock[] {
  if (!tr.docChanged) return blocks;
  return moved(tr, blocks) ?? scan(tr.doc, kinds, blocks);
}

/** The block `pos` is at or in, if any: a binary search, as blocks never
 *  hold one another. */
function blockAt(blocks: readonly DrawnBlock[], pos: number): DrawnBlock | null {
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
function* blocksIn(blocks: readonly DrawnBlock[], from: number, to: number): Generator<DrawnBlock> {
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
const cardsMoved = (previous: readonly DrawnBlock[], blocks: readonly DrawnBlock[], mapping: Mappable) =>
  previous.length === blocks.length &&
  previous.every((block, index) => block.node === blocks[index].node && mapping.map(block.from, -1) === blocks[index].from);

const isDrawn = (block: DrawnBlock | null): block is DrawnBlock => block !== null && block.value !== null;

/** The drawn block that starts at `pos`, if one does. */
function drawnFrom(state: EditorState, pos: number): DrawnBlock | null {
  const block = blockAt(key.getState(state)!.blocks, pos);
  return block?.from === pos && isDrawn(block) ? block : null;
}

/** Shows the source of the drawn block at `pos`, the caret at its start. */
export function editDrawnBlock(view: EditorView, pos: number): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)).setMeta(key, { editing: pos }));
  view.focus();
}

/** The editor's drawn code blocks, of each of `kinds`; a block is the first
 *  kind's that matches it. */
export function drawnCodeBlocks(kinds: readonly DrawnBlockKind[]): Plugin<DrawnBlocksState> {
  /** This editor's drawn cards, each with where its block is (for the
   *  pointer): the card's widget adds it, and removes it when it is gone. */
  const cards = new Map<DrawnBlockElement, () => number | undefined>();

  /** The drawn block a position is inside, if any. */
  const drawnAround = (state: EditorState, pos: number) => {
    const { blocks, editing } = key.getState(state)!;
    const block = blockAt(blocks, pos);
    return isDrawn(block) && pos > block.from && block.from !== editing ? block : null;
  };

  const draw = ({ node, kind, value }: DrawnBlock) => (view: EditorView, getPos: () => number | undefined) => {
    const element = kind.draw(node, value);
    element.contentEditable = "false";
    // What ./extension.css hides the source after: an editor's card, not a
    // rendered reply's (a widget response's) element, whose next block is
    // its own.
    element.setAttribute("data-source-after", "");
    cards.set(element, getPos);
    if (view.editable) {
      element.onEdit = () => {
        const at = getPos();
        if (at !== undefined) editDrawnBlock(view, at);
      };
    }
    return element;
  };

  const decorate = (doc: PMNode, blocks: readonly DrawnBlock[], editing: number | null) =>
    DecorationSet.create(
      doc,
      blocks.flatMap((block) => {
        if (!isDrawn(block) || block.from === editing) return [];
        // The card alone: a stylesheet hides the source after it
        // (./extension.css), as a node decoration per block would make every
        // update of a long document look at each of its blocks for them.
        return [
          Decoration.widget(block.from, draw(block), {
            side: -1,
            // The same card for the same source: a redraw only when it changes.
            key: `${block.kind.name}\n${block.node.attrs.language}\n${block.node.textContent}`,
            ignoreSelection: true,
            stopEvent: () => true,
            destroy: (element) => cards.delete(element as DrawnBlockElement),
          }),
        ];
      }),
    );

  /** The card in this editor an event happened on, if any. */
  const cardAt = (event: MouseEvent) =>
    event
      .composedPath()
      .find((target): target is DrawnBlockElement => target instanceof Element && cards.has(target as DrawnBlockElement)) ??
    null;

  /**
   * The selection a mouse gesture over cards means (rule 1), from the cards
   * it went down and came up on — not the DOM selection, which a browser
   * keeps out of a non-editable card (Chromium stops a drag at its edge).
   */
  const selectFromPointer = (view: EditorView, down: DrawnBlockElement | null, up: DrawnBlockElement | null, event: MouseEvent) => {
    // A click, or a drag within one card: the reader's, not the editor's.
    if (down === up) return;
    const { state } = view;
    const posOf = (card: DrawnBlockElement | null) => (card ? cards.get(card)?.() : undefined);
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
  const cardOf = (view: EditorView, block: DrawnBlock) => {
    const card = view.nodeDOM(block.from)?.previousSibling as DrawnBlockElement | null | undefined;
    return card && cards.has(card) ? card : null;
  };

  /** The cards a selection takes the blocks of in, each with whether the
   *  keys are on it: whether its block is the one selected. */
  const cardsTakenIn = (view: EditorView, blocks: readonly DrawnBlock[]) => {
    const { selection } = view.state;
    const taken = new Map<DrawnBlockElement, boolean>();
    if (selection.empty) return taken;
    for (const block of blocksIn(blocks, selection.from, selection.to)) {
      // All of its source: rule 1 rests a selection's ends just inside it.
      const takenIn = selection.from <= block.from + 1 && selection.to >= block.to - 1;
      const card = takenIn && isDrawn(block) ? cardOf(view, block) : null;
      if (card) taken.set(card, selection instanceof NodeSelection && selection.from === block.from);
    }
    return taken;
  };

  /** The cards wearing the tint, each with whether the keys are on it. */
  let marked = new Map<DrawnBlockElement, boolean>();

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
    editDrawnBlock(view, selection.from);
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

  /** Rule 1: Backspace at the start of the line after a drawn block, or
   *  Delete at the end of the line before one, selects it, as the prompt
   *  widget does (an empty line goes, as it would have) — rather than
   *  joining the line into its hidden source. */
  const selectBeside = (view: EditorView, towards: "back" | "forward") => {
    const { state } = view;
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty || selection.$head.depth === 0) return false;
    const { $head } = selection;
    const back = towards === "back";
    if ($head.parentOffset !== (back ? 0 : $head.parent.content.size)) return false;
    const $edge = state.doc.resolve(back ? $head.before() : $head.after());
    const next = back ? $edge.nodeBefore : $edge.nodeAfter;
    if (!next) return false;
    const at = back ? $edge.pos - next.nodeSize : $edge.pos;
    if (!drawnFrom(state, at)) return false;
    const tr = state.tr;
    if (back && $head.parent.content.size === 0) tr.delete($head.before(), $head.after());
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView());
    return true;
  };

  const attributes = Object.assign({}, ...kinds.map((kind) => kind.attributes ?? {})) as Record<string, string>;

  return new Plugin<DrawnBlocksState>({
    key,
    state: {
      init: (_config, state): DrawnBlocksState => {
        const blocks = scan(state.doc, kinds, []);
        return { blocks, editing: null, decorations: decorate(state.doc, blocks, null) };
      },
      apply: (tr, previous, _old, state) => {
        const blocks = blocksAfter(tr, kinds, previous.blocks);
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
      let down: DrawnBlockElement | null = null;
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
      attributes,
      decorations: (state) => key.getState(state)?.decorations,
      handleKeyDown: (view, event) => {
        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
        if (event.key === "Enter") return editSelected(view);
        if (event.key === "Escape") return leaveEditing(view);
        if (/^[1-9]$/.test(event.key)) return runControl(view, Number(event.key) - 1);
        const deleting = DELETES[event.key];
        if (deleting) return selectBeside(view, deleting);
        const towards = ARROWS[event.key];
        return towards ? selectAcross(view, towards) : false;
      },
    },
  });
}
