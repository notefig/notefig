/**
 * Focus and selection lifecycle for an editor mounted in the dockable tab
 * layout: restores the saved selection on mount, requests focus through the
 * arbiter, reclaims focus lost to layout re-parenting, and saves the
 * selection / blurs cleanly on unmount.
 */

import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import {
  saveSelection,
  getSavedSelection,
  consumePendingNavigation,
  navigateToLocation,
} from "@/components/editor/editor-store";
import { requestTabFocus } from "@/tabs/tab-controllers";
import {
  docHasRealContent,
  findPromptNodeId,
} from "@notefig/widgets";
import { requestPromptBlobFocus } from "@notefig/widgets";

/** How long after mount the tab layout may still re-parent the editor DOM. */
const FOCUS_RECLAIM_WINDOW_MS = 600;

export function useEditorFocusLifecycle(
  editor: Editor,
  filePath: string,
): void {
  useEffect(() => {
    if (!editor) return;

    // A navigation intent (search result click) that arrived while this
    // editor was unmounted or being recreated lands here; it wins over
    // the saved-selection restore.
    const pending = consumePendingNavigation(filePath);
    if (pending) {
      navigateToLocation(filePath, pending);
    } else {
      const saved = getSavedSelection(filePath);
      if (
        saved &&
        saved.from <= editor.state.doc.content.size &&
        saved.to <= editor.state.doc.content.size
      ) {
        editor.commands.setTextSelection(saved);
      }
    }

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
        // On an empty keeper doc the composer textarea is the rightful
        // owner (the arbiter declines ambient editor intents there), so
        // reclaim to it — re-parenting drops its focus just like the
        // editor's, and nothing else restores it.
        const doc = editor.state.doc;
        const keeperId = docHasRealContent(doc)
          ? null
          : findPromptNodeId(doc);
        if (keeperId) {
          requestPromptBlobFocus(keeperId);
        } else {
          requestTabFocus(filePath, {
            when: "immediate",
            reason: "focus-lost-after-mount",
          });
        }
      }
      reclaimRaf = requestAnimationFrame(reclaim);
    };
    reclaimRaf = requestAnimationFrame(reclaim);

    return () => {
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
