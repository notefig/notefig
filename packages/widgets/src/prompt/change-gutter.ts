/**
 * How a round's changes look in the document: a thin bar in the editor's
 * left gutter beside every block the round changed, in the widget's colour —
 * the dirty-diff gutter of a code editor. The text itself is never styled.
 *
 * Only the widget under review is drawn (review is one widget at a time,
 * started from the widget — see `setPromptReview`). The marks are passive:
 * they show state, nothing more. Moving between changes is the widget's
 * job (./change-navigator.ts), which asks this module to reveal a block —
 * scroll it into view and pulse its bar so the eye lands on it. A block the round only removed has no
 * mark: there is no undo to offer for it yet, and a mark with nothing to
 * do is noise.
 *
 * The gutter is a layer beside the editor, not decorations on its blocks: a
 * nested list item's bar still lands in the gutter (block CSS cannot know
 * its depth), and ProseMirror's DOM is never touched. Like the minimap
 * rail, it is a plugin view — registering the plugin is the whole
 * installation.
 *
 * Purely a view of `promptChangesOf(state)` — swapping this module for a
 * margin list or a diff overlay touches nothing in the tracking.
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, PluginView } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { promptChangesOf } from "./change-tracking";
import {
  getPromptReview,
  promptChangeColor,
  subscribePromptChanges,
} from "./change-store";

const gutterKey = new PluginKey("promptChangeGutter");

/** One widget's mark on one changed block. */
export type PromptChangeMark = {
  /** Position before the block. */
  pos: number;
  blobId: string;
};

/**
 * The changed blocks, one mark per block and widget, in document order. A
 * change inside a textblock (text written, or text removed from the line)
 * marks that block; a change between blocks (a whole block removed) has no
 * block left to mark.
 */
export function promptChangeMarks(state: EditorState): PromptChangeMark[] {
  const marks = new Map<string, PromptChangeMark>();
  for (const change of promptChangesOf(state)) {
    const $pos = state.doc.resolve(change.from);
    if (!$pos.parent.isTextblock) continue;
    const pos = $pos.before();
    marks.set(`${pos}:${change.blobId}`, { pos, blobId: change.blobId });
  }
  return [...marks.values()].sort((a, b) => a.pos - b.pos);
}

/** Gutter offset left of the text, and the spacing between two widgets'
 *  bars on one block (px). */
const GUTTER_OFFSET = 14;
const BAR_SPACING = 6;
/** How long a revealed bar stays emphasised. Cosmetic only. */
const PULSE_MS = 900;

const BAR_CLASS =
  "pointer-events-none absolute w-[3px] -translate-x-1/2 rounded-full bg-(--prompt-change) transition-[width,box-shadow] duration-300 data-[pulse]:w-[5px] data-[pulse]:shadow-[0_0_0_3px_var(--prompt-change-glow)]";

const gutters = new WeakMap<EditorView, PromptChangeGutter>();

/**
 * Bring one of a widget's changed blocks into view and pulse its bar. The
 * navigator's half of the contract; a no-op in an editor without the plugin.
 */
export function revealPromptChange(
  view: EditorView,
  mark: PromptChangeMark,
): void {
  const dom = view.nodeDOM(mark.pos);
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  gutters.get(view)?.pulse(mark);
}

class PromptChangeGutter implements PluginView {
  private readonly layer: HTMLDivElement;
  private readonly resize: ResizeObserver | null;
  private lastMarks: PromptChangeMark[] = [];
  private observed = new Set<Element>();
  private pulsed: PromptChangeMark | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly view: EditorView) {
    // A zero-height layer just before the editor: it scrolls with the
    // document, so marks placed once stay put until layout changes.
    this.layer = document.createElement("div");
    this.layer.setAttribute("data-prompt-change-gutter", "");
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.style.cssText =
      "position:relative;height:0;overflow:visible;pointer-events:none;";
    view.dom.before(this.layer);
    // Reflow moves blocks without a transaction: a resized pane, a wrapped
    // line, a loaded image, a tab shown again, a widget card growing. The
    // editor element itself often keeps its size (it fills the pane), so
    // its top-level blocks are watched too — a block moves only when
    // something above it changes size.
    this.resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => this.render(true));
    gutters.set(view, this);
    // A review starting or ending changes what is drawn without touching
    // the document.
    this.unsubscribe = subscribePromptChanges(() => this.render(false));
    this.render(true);
  }

  update(view: EditorView, previous: EditorState): void {
    // Selection-only updates move nothing; a doc change may move every
    // block below it, so marks are re-measured whenever it changes.
    if (view.state.doc === previous.doc && this.lastMarks.length === 0) return;
    this.render(view.state.doc !== previous.doc);
  }

  destroy(): void {
    clearTimeout(this.pulseTimer);
    this.unsubscribe();
    this.resize?.disconnect();
    gutters.delete(this.view);
    this.layer.remove();
  }

  pulse(mark: PromptChangeMark): void {
    clearTimeout(this.pulseTimer);
    this.pulsed = mark;
    this.render(true);
    this.pulseTimer = setTimeout(() => {
      this.pulsed = null;
      this.render(true);
    }, PULSE_MS);
  }

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
    const reviewing = getPromptReview();
    const marks = promptChangeMarks(this.view.state).filter(
      (mark) => mark.blobId === reviewing,
    );
    if (!force && sameMarks(marks, this.lastMarks)) return;
    this.lastMarks = marks;
    this.layer.replaceChildren();
    this.observeLayout(marks.length > 0);
    if (marks.length === 0) return;
    const origin = this.layer.getBoundingClientRect();
    const gutterX =
      this.view.dom.getBoundingClientRect().left - origin.left - GUTTER_OFFSET;
    const barsOnBlock = new Map<number, number>();
    for (const mark of marks) {
      const dom = this.view.nodeDOM(mark.pos);
      if (!(dom instanceof HTMLElement)) continue;
      const box = dom.getBoundingClientRect();
      const index = barsOnBlock.get(mark.pos) ?? 0;
      barsOnBlock.set(mark.pos, index + 1);
      const bar = markBar(mark, {
        left: gutterX - index * BAR_SPACING,
        top: box.top - origin.top,
        height: box.height,
      });
      if (this.pulsed && sameMark(this.pulsed, mark)) bar.dataset.pulse = "";
      this.layer.append(bar);
    }
  }
}

/** One mark: a bar spanning its block. */
function markBar(
  mark: PromptChangeMark,
  at: { left: number; top: number; height: number },
): HTMLDivElement {
  const el = document.createElement("div");
  el.dataset.promptChangeMark = mark.blobId;
  el.className = BAR_CLASS;
  el.style.setProperty("--prompt-change", promptChangeColor(mark.blobId));
  el.style.setProperty(
    "--prompt-change-glow",
    promptChangeColor(mark.blobId, 0.25),
  );
  el.style.left = `${at.left}px`;
  el.style.top = `${at.top}px`;
  el.style.height = `${at.height}px`;
  return el;
}

function sameMark(a: PromptChangeMark, b: PromptChangeMark): boolean {
  return a.pos === b.pos && a.blobId === b.blobId;
}

function sameMarks(a: PromptChangeMark[], b: PromptChangeMark[]): boolean {
  return a.length === b.length && a.every((mark, i) => sameMark(mark, b[i]));
}

export function promptChangeGutterPlugin(): Plugin {
  return new Plugin({
    key: gutterKey,
    view: (view) => new PromptChangeGutter(view),
  });
}
