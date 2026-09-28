/**
 * The widget's side of change review: how many blocks its round changed in
 * this document, stepping through them (each step scrolls the block into
 * view and pulses its gutter bar), and clearing them all.
 *
 * Reads the same marks the gutter draws (`promptChangeMarks`), so the count
 * and the bars can never disagree, and re-reads whenever the change store
 * moves — which the tracking plugin makes happen after every transaction
 * that moves a change.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  discardPromptChanges,
  promptChangeColor,
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
  /** 0-based position of the last revealed block, null before the first. */
  index: number | null;
  /** The widget's review colour — its gutter bars'. */
  color: string;
  step(direction: 1 | -1): void;
  clear(): void;
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
  const [position, setPosition] = useState<number | null>(null);
  // Blocks can merge or go away under the cursor; the position never
  // points past the end.
  const index = position === null || count === 0 ? null : Math.min(position, count - 1);

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
      revealPromptChange(editor.view, marks[next]);
    },
    [editor, blobId, index],
  );

  const clear = useCallback(() => {
    setPosition(null);
    discardPromptChanges(blobId);
  }, [blobId]);

  return { count, index, color: promptChangeColor(blobId), step, clear };
}
