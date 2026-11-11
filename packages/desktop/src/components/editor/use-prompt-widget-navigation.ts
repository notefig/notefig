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
  if (range && draftVisible) {
    tr = tr.setSelection(TextSelection.create(tr.doc, range.to));
  } else {
    tr = selectWidget(tr, pos);
  }
  tr = tr.scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
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
