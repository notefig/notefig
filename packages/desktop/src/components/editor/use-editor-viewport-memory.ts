/**
 * Reading-position memory for a document: which part of it was on screen,
 * remembered with the editor instance rather than with the mounted
 * component.
 *
 * The dock mounts only the selected tab, so a tab switch destroys the scroll
 * container along with the rest of the DOM. The Tiptap instance itself
 * outlives that (`editor-store.ts`), which is already where the caret and
 * selection survive — this puts the reading position in the same place, so
 * returning to a document lands where the document was left.
 *
 * What is remembered is a document position, not a pixel offset: the file
 * can be edited on disk while the tab is away and adopted into the open
 * editor, which moves every offset but not the text the user was reading.
 * Restoring is then just scrolling that position's node back to the top —
 * accurate to the start of a block rather than to the pixel, which is not a
 * difference anyone can see.
 */
import { useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { getSavedViewport, saveViewport } from "@/components/editor/editor-store";

/** @returns the ref to put on the document's scroll container. */
export function useEditorViewportMemory(editor: Editor, filePath: string) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    restoreViewport(editor, filePath);

    // Derived on scroll rather than on unmount: the teardown order between
    // this and ProseMirror's own view is not ours to rely on, and by then
    // the position may no longer be measurable. Once per frame — scroll
    // events are cheap, `posAtCoords` is a layout read.
    let scheduled: number | null = null;
    const handleScroll = () => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = null;
        const pos = topVisiblePos(editor, scrollEl);
        if (pos !== null) saveViewport(filePath, pos);
      });
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      scrollEl.removeEventListener("scroll", handleScroll);
    };
  }, [editor, filePath]);

  return scrollRef;
}

/** The document position at the top edge of the visible area. */
function topVisiblePos(editor: Editor, scrollEl: HTMLElement): number | null {
  const content = editor.view.dom.getBoundingClientRect();
  // Probed down the middle of the prose column: the scroll container spans
  // the side gutters too, and a point outside the text resolves to nothing.
  const found = editor.view.posAtCoords({
    left: content.left + content.width / 2,
    top: scrollEl.getBoundingClientRect().top + 1,
  });
  return found?.pos ?? null;
}

function restoreViewport(editor: Editor, filePath: string): void {
  const pos = getSavedViewport(filePath);
  if (pos === undefined || pos > editor.state.doc.content.size) return;

  try {
    const { node } = editor.view.domAtPos(pos);
    // domAtPos can land on a text node, which has nothing to scroll.
    const element = node instanceof Element ? node : node.parentElement;
    // `nearest` inline so a wide table can't also scroll the row sideways.
    element?.scrollIntoView({ block: "start", inline: "nearest" });
  } catch {
    // A position the current view can't resolve (the document was replaced
    // underneath us) — leave the editor where it opened.
  }
}
