/**
 * The widget's side of change review, driven from its file chips. A review
 * is a mode on one widget at a time: turning it on marks this widget's
 * changed blocks in the gutter (and ends any other widget's review);
 * turning it off hides them again. The
 * changes themselves stay until the widget moves on to a new turn, so there
 * is nothing to clear.
 *
 * `step` walks the changed blocks in this document — scrolling each into
 * view and pulsing its bar. The widget does not render it yet; it is kept
 * for the stepping controls to come.
 *
 * Reads the same marks the gutter draws (`promptChangeMarks`), so the count
 * and the bars can never disagree, and re-reads whenever the change store
 * moves — which the tracking plugin makes happen after every transaction
 * that moves a change.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  getPromptReview,
  promptChangeColor,
  setPromptReview,
  subscribePromptChanges,
} from "./change-store";
import {
  promptChangeMarks,
  revealPromptChange,
  type PromptChangeMark,
} from "./change-gutter";

export type PromptChangeNavigation = {
  /** Changed blocks in this document. */
  count: number;
  /** Whether this widget is the one under review. */
  reviewing: boolean;
  /** The widget's review colour — its gutter bars'. */
  color: string;
  toggleReview(): void;
  /** Turn this widget's review on (idempotent). */
  showChanges(): void;
  /** 0-based position of the last revealed block, null before the first. */
  index: number | null;
  step(direction: 1 | -1): void;
};

function widgetMarks(editor: Editor, blobId: string): PromptChangeMark[] {
  if (editor.isDestroyed) return [];
  return promptChangeMarks(editor.state).filter(
    (mark) => mark.blobId === blobId,
  );
}

export function usePromptChangeNavigation(
  blobId: string,
  editor: Editor,
): PromptChangeNavigation {
  const count = useSyncExternalStore(
    subscribePromptChanges,
    () => widgetMarks(editor, blobId).length,
  );
  const reviewing = useSyncExternalStore(
    subscribePromptChanges,
    () => getPromptReview() === blobId,
  );
  const [position, setPosition] = useState<number | null>(null);
  // Blocks can merge or go away under the cursor; the position never
  // points past the end.
  const index =
    position === null || count === 0 ? null : Math.min(position, count - 1);

  const toggleReview = useCallback(() => {
    setPosition(null);
    setPromptReview(getPromptReview() === blobId ? null : blobId);
  }, [blobId]);

  const showChanges = useCallback(() => setPromptReview(blobId), [blobId]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const marks = widgetMarks(editor, blobId);
      if (marks.length === 0) return;
      const next =
        index === null
          ? direction === 1
            ? 0
            : marks.length - 1
          : (index + direction + marks.length) % marks.length;
      setPosition(next);
      setPromptReview(blobId);
      revealPromptChange(editor.view, marks[next]);
    },
    [editor, blobId, index],
  );

  return {
    count,
    reviewing,
    color: promptChangeColor(blobId),
    toggleReview,
    showChanges,
    index,
    step,
  };
}
