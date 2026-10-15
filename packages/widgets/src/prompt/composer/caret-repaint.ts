/**
 * WebKit — the desktop app's webview — doesn't repaint the caret when text
 * changes inside an inline decoration: the "@query" a suggestion highlights.
 * ProseMirror finds the DOM selection already where it belongs and leaves it
 * alone, so nothing tells WebKit to redraw: the caret stays at its old spot,
 * or vanishes, until its next blink (up to ~0.5s per Backspace with the "@"
 * menu open, measured frame by frame). Setting the same selection again
 * makes WebKit draw it where it is.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/** The class @tiptap/suggestion gives the "@query" it highlights. */
const SUGGESTION_CLASS = "suggestion";

/** Whether the caret's DOM spot is in a suggestion's highlight or just past
 *  it — ProseMirror may put the caret after the span, in its parent. Looks
 *  only there, not through the whole document. */
function nearSuggestion(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !!(
    element?.closest(`.${SUGGESTION_CLASS}`) ||
    element?.querySelector(`:scope > .${SUGGESTION_CLASS}`)
  );
}

export function suggestionCaretRepaint(): Plugin {
  return new Plugin({
    view: () => ({
      update(view, previous) {
        if (view.state.doc === previous.doc || !view.hasFocus()) return;
        if (!nearSuggestion(view.domAtPos(view.state.selection.head).node)) return;
        const selection = (view.root as Document).getSelection?.();
        if (!selection?.isCollapsed || !selection.rangeCount) return;
        // After ProseMirror is done with this update's DOM and selection.
        queueMicrotask(() => {
          if (!selection.rangeCount) return;
          const range = selection.getRangeAt(0).cloneRange();
          selection.removeAllRanges();
          selection.addRange(range);
        });
      },
    }),
  });
}

/** The same, for an editor's extension list (the chat composer). */
export const SuggestionCaretRepaint = Extension.create({
  name: "suggestionCaretRepaint",
  addProseMirrorPlugins: () => [suggestionCaretRepaint()],
});
