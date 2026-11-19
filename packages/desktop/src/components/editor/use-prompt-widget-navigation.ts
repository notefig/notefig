/**
 * Keyboard navigation across a document's prompt widgets: jump to the
 * next, previous, first or last widget without leaving the keyboard.
 *
 * Bound globally but guarded by whether the editor has focus, so these only
 * fire while a document is active. A widget with a visible composer lands the
 * caret in its draft; a running/completed widget (the composer is hidden) is
 * selected as a node and scrolled into view.
 */
import { useCallback } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { Editor } from "@tiptap/core";
import {
  collectWidgets,
  PROMPT_NODE_NAME,
  promptDraftRange,
  selectWidget,
} from "@notefig/widgets";
import { TextSelection } from "@tiptap/pm/state";

type Direction = "next" | "prev" | "first" | "last";

/**
 * The position to use as the navigation reference: if the caret is inside
 * a prompt widget, the position directly before that widget node. Otherwise
 * the current selection position. Using the widget's boundary (not the
 * caret's exact offset) lets "next" and "previous" both skip the widget we
 * are already typing in.
 */
function referencePos(editor: Editor): number {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === PROMPT_NODE_NAME) {
      return $from.before(depth);
    }
  }
  return editor.state.selection.from;
}

/**
 * Resolve which widget position to jump to. Widgets are returned in document
 * order by `collectWidgets`. Next/previous wrap around the document because
 * the user asked to move, not to be told there are no more widgets.
 */
function resolveTargetPos(editor: Editor, direction: Direction): number | null {
  const widgets = collectWidgets(editor.state.doc);
  if (widgets.length === 0) return null;

  switch (direction) {
    case "first":
      return widgets[0].pos;
    case "last":
      return widgets[widgets.length - 1].pos;
    case "next": {
      const ref = referencePos(editor);
      const next = widgets.find((w) => w.pos > ref);
      return next?.pos ?? widgets[0].pos;
    }
    case "prev": {
      const ref = referencePos(editor);
      for (let i = widgets.length - 1; i >= 0; i--) {
        if (widgets[i].pos < ref) return widgets[i].pos;
      }
      return widgets[widgets.length - 1].pos;
    }
    default:
      return null;
  }
}

/**
 * Move the selection and focus to the prompt widget at `pos`. When the
 * widget's composer is visible, the caret lands at the end of its draft
 * (matching the existing reveal behavior). When the composer is hidden, the
 * widget node is selected so repeated navigation keeps working.
 */
function focusAndScrollToWidget(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== PROMPT_NODE_NAME) return;

  const blobId = node.attrs.blobId as string | null;
  const range = blobId ? promptDraftRange(editor.state.doc, blobId) : null;
  const widgetEl = editor.view.nodeDOM(pos);
  const draftEl =
    widgetEl instanceof HTMLElement
      ? widgetEl.querySelector<HTMLElement>("[data-prompt-draft]")
      : null;
  const draftVisible = draftEl && draftEl.getClientRects().length > 0;

  let tr = editor.state.tr;
  let caretPos: number | null = null;
  if (range && draftVisible) {
    caretPos = range.to;
    tr = tr.setSelection(TextSelection.create(tr.doc, range.to));
  } else {
    tr = selectWidget(tr, pos);
  }
  // Not the transaction's `scrollIntoView`: its minimal scroll drops the
  // caret on a viewport edge and hides the card the input belongs to
  // (MET-286). The jump centers its landing point in the viewport instead —
  // after the selection and focus land, so the browser's own scroll for the
  // new caret can't undo it.
  editor.view.dispatch(tr);
  editor.view.focus();
  const target =
    draftVisible && draftEl
      ? draftEl
      : widgetEl instanceof HTMLElement
        ? widgetEl
        : null;
  if (target) centerScrollTarget(editor, target, caretPos);
}

/** The nearest ancestor that scrolls vertically — the document's scroller
 *  for anything inside the editor. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Center the jump's landing point in the scroll container's viewport: the
 * draft the caret moved into, or the widget card when the composer is
 * hidden. A draft taller than the viewport centers the caret's line
 * instead — centering the draft itself would leave the caret (at the
 * draft's end) below the fold.
 *
 * The widget card animates its height (AnimatedHeight's measured-height
 * transition), and a jump can land before that transition has even started
 * (the ResizeObserver → React → style pipeline runs a few frames behind the
 * edit) or while it is moving under the landing point. So the aim repeats
 * on the following frames while the landing point moves in document space,
 * and stops once it has held still past the transition's reach — re-aiming
 * only on layout change, so a scroll the user makes after landing is
 * theirs. A newer jump takes the watch over.
 */
let scrollWatch = 0;
const SCROLL_SETTLE_GRACE_MS = 350;
const SCROLL_WATCH_CAP_MS = 1000;
function centerScrollTarget(
  editor: Editor,
  target: HTMLElement,
  caretPos: number | null,
): void {
  const scroller = scrollParentOf(target);
  if (!scroller) return;

  /** Scroll the landing point to the viewport's middle. */
  const aim = (frame: DOMRect, mid: number): void => {
    const wanted = scroller.scrollTop + (mid - frame.top - frame.height / 2);
    scroller.scrollTop = Math.max(
      0,
      Math.min(wanted, scroller.scrollHeight - scroller.clientHeight),
    );
  };

  /** One frame: re-aim while the landing point moves in document space.
   *  True to keep watching. */
  const token = ++scrollWatch;
  const startedAt = performance.now();
  let lastMidDoc: number | null = null;
  const step = (): boolean => {
    if (
      token !== scrollWatch ||
      editor.isDestroyed ||
      !scroller.isConnected ||
      performance.now() - startedAt >= SCROLL_WATCH_CAP_MS
    ) {
      return false;
    }
    // A target with no boxes is gone for good — the widget was deleted or
    // its composer hid (a fresh rect would read zero and pull the scroll
    // upward every frame); the landing point no longer exists to track.
    if (target.getClientRects().length === 0) return false;
    const frame = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    let mid = (rect.top + rect.bottom) / 2;
    if (caretPos !== null && rect.height > frame.height) {
      try {
        const caret = editor.view.coordsAtPos(caretPos);
        mid = (caret.top + caret.bottom) / 2;
      } catch {
        // The caret no longer resolves to a point (the view moved
        // underneath): center the target as it is.
      }
    }
    const midDoc = mid + scroller.scrollTop;
    const moved = lastMidDoc === null || Math.abs(midDoc - lastMidDoc) >= 1;
    lastMidDoc = midDoc;
    if (!moved) {
      // Hold still — but the card's height transition may not have started
      // yet; only trust the stillness once it had its chance.
      return performance.now() - startedAt < SCROLL_SETTLE_GRACE_MS;
    }
    aim(frame, mid);
    return true;
  };

  step();
  const watch = () => {
    if (!step()) return;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

/**
 * Navigate the document's prompt widgets. Returns whether a widget was
 * found and moved to.
 */
export function navigateToPromptWidget(
  editor: Editor,
  direction: Direction,
): boolean {
  const targetPos = resolveTargetPos(editor, direction);
  if (targetPos === null) return false;
  focusAndScrollToWidget(editor, targetPos);
  return true;
}

/**
/**
 * Register the widget navigation hotkeys on the document. They only act when
 * this editor instance currently has focus, so each open document responds
 * only for its own caret.
 *
 * - Mod+ArrowDown  -> next widget
 * - Mod+ArrowUp    -> previous widget
 * - Mod+Shift+ArrowDown -> last widget
 * - Mod+Shift+ArrowUp   -> first widget
 */
export function usePromptWidgetNavigation(editor: Editor): void {
  const navigate = useCallback(
    (direction: Direction) => () => {
      if (!editor.isFocused) return;
      navigateToPromptWidget(editor, direction);
    },
    [editor],
  );

  useHotkey({ key: "ArrowDown", mod: true }, navigate("next"));
  useHotkey({ key: "ArrowUp", mod: true }, navigate("prev"));
  useHotkey({ key: "ArrowDown", mod: true, shift: true }, navigate("last"));
  useHotkey({ key: "ArrowUp", mod: true, shift: true }, navigate("first"));
}
