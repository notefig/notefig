/**
 * How a round's changes look in the document: a bar in the editor's left
 * gutter beside every block the round changed, in the widget's colour, and
 * a small diamond at the top edge of the block where the round only removed
 * content — the dirty-diff gutter of a code editor. The text itself is
 * never styled.
 *
 * The gutter is a layer beside the editor, not decorations on its blocks: a
 * nested list item's bar still lands in the gutter (block CSS cannot know
 * its depth), the marks are real elements with a hover and a tooltip (the
 * prompt that made the change), and ProseMirror's DOM is never touched.
 * Like the minimap rail, it is a plugin view — registering the plugin is
 * the whole installation. Clicking a mark dismisses that block's changes.
 *
 * Purely a view of `promptChangesOf(state)` — swapping this module for a
 * margin list or a diff overlay touches nothing in the tracking.
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, PluginView } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { dismissPromptChangesTr, promptChangesOf } from "./change-tracking";
import { promptChangeColor, type PromptChange } from "./change-store";
import { getPromptBlob } from "./store";

const gutterKey = new PluginKey("promptChangeGutter");

/** One widget's mark on one block. */
export type PromptChangeMark = {
  /** Position before the block. */
  pos: number;
  blobId: string;
  /** "changed": the block's content changed; "removed": content that sat
   *  just above the block was removed. */
  kind: "changed" | "removed";
};

/**
 * The block a change belongs to. A span or a point inside a textblock marks
 * that block as changed; a point between blocks (a removed block) marks the
 * block that now sits where it was, or the last one at the document's end.
 */
function markOf(state: EditorState, change: PromptChange): PromptChangeMark | null {
  const $pos = state.doc.resolve(change.from);
  if ($pos.parent.isTextblock) {
    return { pos: $pos.before(), blobId: change.blobId, kind: "changed" };
  }
  if ($pos.nodeAfter?.isBlock) {
    return { pos: change.from, blobId: change.blobId, kind: "removed" };
  }
  const before = $pos.nodeBefore;
  if (before?.isBlock) {
    return {
      pos: change.from - before.nodeSize,
      blobId: change.blobId,
      kind: "removed",
    };
  }
  return null;
}

/** One mark per block and widget, in document order; "changed" wins. */
export function promptChangeMarks(state: EditorState): PromptChangeMark[] {
  const marks = new Map<string, PromptChangeMark>();
  for (const change of promptChangesOf(state)) {
    const mark = markOf(state, change);
    if (!mark) continue;
    const key = `${mark.pos}:${mark.blobId}`;
    if (marks.get(key)?.kind !== "changed") marks.set(key, mark);
  }
  return [...marks.values()].sort((a, b) => a.pos - b.pos);
}

/** Gutter offset left of the text, and the spacing between two widgets'
 *  bars on one block (px). */
const GUTTER_OFFSET = 14;
const BAR_SPACING = 6;

const BAR_CLASS =
  "group/mark absolute w-2.5 -translate-x-1/2 cursor-pointer before:absolute before:inset-y-0 before:left-1/2 before:w-[3px] before:-translate-x-1/2 before:rounded-full before:bg-(--prompt-change) before:transition-[width] hover:before:w-[5px]";
const REMOVED_CLASS =
  "absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-pointer rounded-[2px] bg-(--prompt-change) transition-transform hover:scale-125";

class PromptChangeGutter implements PluginView {
  private readonly layer: HTMLDivElement;
  private readonly resize: ResizeObserver | null;
  private lastMarks: PromptChangeMark[] = [];
  private observed = new Set<Element>();

  constructor(private readonly view: EditorView) {
    // A zero-height layer just before the editor: it scrolls with the
    // document, so marks placed once stay put until layout changes.
    this.layer = document.createElement("div");
    this.layer.setAttribute("data-prompt-change-gutter", "");
    this.layer.style.cssText = "position:relative;height:0;overflow:visible;";
    view.dom.before(this.layer);
    this.layer.addEventListener("mousedown", this.onMouseDown);
    // Reflow moves blocks without a transaction: a resized pane, a wrapped
    // line, a loaded image, a tab shown again, a widget card growing. The
    // editor element itself often keeps its size (it fills the pane), so
    // its top-level blocks are watched too — a block moves only when
    // something above it changes size.
    this.resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => this.render(true));
    this.render(true);
  }

  update(view: EditorView, previous: EditorState): void {
    // Selection-only updates move nothing; a doc change may move every
    // block below it, so marks are re-measured whenever it changes.
    if (view.state.doc === previous.doc && this.lastMarks.length === 0) return;
    this.render(view.state.doc !== previous.doc);
  }

  destroy(): void {
    this.resize?.disconnect();
    this.layer.removeEventListener("mousedown", this.onMouseDown);
    this.layer.remove();
  }

  private readonly onMouseDown = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const pos = Number(target.dataset.pos);
    const node = this.view.state.doc.nodeAt(pos);
    if (!target.dataset.pos || !node) return;
    // Keep the caret and focus where they were: the gutter is not text.
    event.preventDefault();
    this.view.dispatch(
      dismissPromptChangesTr(this.view.state, pos, pos + node.nodeSize),
    );
  };

  /**
   * Watch the editor and its top-level blocks while there are marks to keep
   * in place, nothing when there are none. Only the difference is applied:
   * every observe() reports once straight away, so re-observing on each
   * render would re-render forever.
   */
  private observeLayout(active: boolean): void {
    if (!this.resize) return;
    const next = new Set<Element>(
      active ? [this.view.dom, ...this.view.dom.children] : [],
    );
    for (const el of this.observed) {
      if (!next.has(el)) this.resize.unobserve(el);
    }
    for (const el of next) {
      if (!this.observed.has(el)) this.resize.observe(el);
    }
    this.observed = next;
  }

  private render(force: boolean): void {
    const marks = promptChangeMarks(this.view.state);
    if (!force && sameMarks(marks, this.lastMarks)) return;
    this.lastMarks = marks;
    this.layer.replaceChildren();
    this.observeLayout(marks.length > 0);
    if (marks.length === 0) return;
    const origin = this.layer.getBoundingClientRect();
    const textLeft = this.view.dom.getBoundingClientRect().left;
    const barsOnBlock = new Map<number, number>();
    for (const mark of marks) {
      const dom = this.view.nodeDOM(mark.pos);
      if (!(dom instanceof HTMLElement)) continue;
      const box = dom.getBoundingClientRect();
      const index = barsOnBlock.get(mark.pos) ?? 0;
      barsOnBlock.set(mark.pos, index + 1);
      const el = document.createElement("button");
      el.type = "button";
      el.tabIndex = -1;
      el.dataset.pos = String(mark.pos);
      el.dataset.promptChangeMark = mark.kind;
      el.dataset.blobId = mark.blobId;
      el.className = mark.kind === "changed" ? BAR_CLASS : REMOVED_CLASS;
      el.style.setProperty("--prompt-change", promptChangeColor(mark.blobId));
      el.style.left = `${textLeft - origin.left - GUTTER_OFFSET - index * BAR_SPACING}px`;
      el.style.top = `${box.top - origin.top}px`;
      if (mark.kind === "changed") el.style.height = `${box.height}px`;
      else el.style.top = `${box.top - origin.top - 6}px`;
      const prompt = getPromptBlob(mark.blobId).lastSentPrompt.trim();
      if (prompt) el.title = prompt.split("\n", 1)[0];
      this.layer.append(el);
    }
  }
}

function sameMarks(a: PromptChangeMark[], b: PromptChangeMark[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (mark, i) =>
        mark.pos === b[i].pos &&
        mark.blobId === b[i].blobId &&
        mark.kind === b[i].kind,
    )
  );
}

export function promptChangeGutterPlugin(): Plugin {
  return new Plugin({
    key: gutterKey,
    view: (view) => new PromptChangeGutter(view),
  });
}
