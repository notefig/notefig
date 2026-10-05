/**
 * Focus and selection lifecycle for an editor mounted in the dockable tab
 * layout: restores the saved selection on mount, reports the editor mounted
 * (which runs any `goTo` waiting for it), requests focus through the
 * arbiter, reclaims focus lost to layout re-parenting, and saves the
 * selection / blurs cleanly on unmount.
 */

import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import {
  saveSelection,
  getSavedSelection,
} from "@/components/editor/editor-store";
import { markEditorMounted, markEditorUnmounted } from "@/entities/editors";
import { requestTabFocus } from "@/tabs/tab-controllers";

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
    // After the restore: a goTo that was waiting for this mount (a search
    // result click that opened the tab) runs now and wins over it.
    markEditorMounted(filePath);

    requestTabFocus(filePath, {
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
        // One reclaim for every caret in the document, the widget's prompt
        // draft included: it is content of this editor, so focusing the
        // editor puts the caret back where the state selection already is.
        requestTabFocus(filePath, {
          when: "immediate",
          reason: "focus-lost-after-mount",
        });
      }
      reclaimRaf = requestAnimationFrame(reclaim);
    };
    reclaimRaf = requestAnimationFrame(reclaim);

    return () => {
      markEditorUnmounted(filePath);
      if (reclaimRaf !== null) cancelAnimationFrame(reclaimRaf);
      if (editor.isDestroyed) return;
      const { from, to } = editor.state.selection;
      // Closing a tab/pane can unmount EditorContent (detaching the view)
      // before this cleanup runs — editor.view is a throwing getter then,
      // and isFocused reads through it too. No view means no focus state
      // to save or blur, so bail out.
      let viewDom: HTMLElement;
      try {
        viewDom = editor.view.dom as HTMLElement;
      } catch {
        if (from !== to) saveSelection(filePath, from, to);
        return;
      }
      if (from !== to || editor.isFocused) {
        saveSelection(filePath, from, to);
      }
      // Detaching the editor's DOM from the document (tab switch) drops
      // focus without a blur event — PM's view.hasFocus() stays stale.
      // Explicitly blur so the next mount starts from a clean state.
      viewDom.blur();
    };
  }, [editor, filePath]);
}
