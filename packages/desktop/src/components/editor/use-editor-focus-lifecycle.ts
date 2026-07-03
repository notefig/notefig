/**
 * Focus and selection lifecycle for an editor mounted in the dockable tab
 * layout: restores the saved selection on mount, requests focus through the
 * arbiter, reclaims focus lost to layout re-parenting, and saves the
 * selection / blurs cleanly on unmount.
 */

import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import {
  requestEditorFocus,
  saveSelection,
  getSavedSelection,
} from "@/components/editor/editor-store";

/** How long after mount the tab layout may still re-parent the editor DOM. */
const FOCUS_RECLAIM_WINDOW_MS = 600;

export function useEditorFocusLifecycle(
  editor: Editor,
  filePath: string,
): void {
  useEffect(() => {
    if (!editor) return;

    const saved = getSavedSelection(filePath);
    if (
      saved &&
      saved.from <= editor.state.doc.content.size &&
      saved.to <= editor.state.doc.content.size
    ) {
      editor.commands.setTextSelection(saved);
    }

    requestEditorFocus(filePath, {
      when: "next-frame",
      reason: "text-editor-mount",
    });

    // Tab-layout settling can re-parent the editor DOM after focus lands,
    // which silently drops focus to <body> without a blur event — leaving
    // ProseMirror's internal focus flag stale and click-to-place-caret
    // broken. Reclaim through the arbiter, but only while focus sits on
    // <body> (i.e. nothing else legitimately took it). Frame-by-frame for
    // the settle window so user input can't slip into the gap.
    const start = Date.now();
    let reclaimRaf: number | null = null;
    const reclaim = () => {
      if (Date.now() - start > FOCUS_RECLAIM_WINDOW_MS) {
        reclaimRaf = null;
        return;
      }
      if (document.activeElement === document.body && !editor.view.hasFocus()) {
        requestEditorFocus(filePath, {
          when: "immediate",
          reason: "focus-lost-after-mount",
        });
      }
      reclaimRaf = requestAnimationFrame(reclaim);
    };
    reclaimRaf = requestAnimationFrame(reclaim);

    return () => {
      if (reclaimRaf !== null) cancelAnimationFrame(reclaimRaf);
      const { from, to } = editor.state.selection;
      if (from !== to || editor.isFocused) {
        saveSelection(filePath, from, to);
      }
      // Detaching the editor's DOM from the document (tab switch) drops
      // focus without a blur event — PM's view.hasFocus() stays stale.
      // Explicitly blur so the next mount starts from a clean state.
      (editor.view.dom as HTMLElement).blur();
    };
  }, [editor, filePath]);
}
