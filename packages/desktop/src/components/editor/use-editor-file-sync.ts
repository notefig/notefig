/**
 * Wires an editor to its file's DocumentSync pipeline (see
 * utils/markdown-conversion.ts, which owns save coalescing, baselines and
 * adoption decisions). This hook translates editor events into pipeline
 * calls and pipeline results into `setContent`, and owns the autosave
 * debounce: updates reach the pipeline once per typing pause, so disk
 * writes (and the watcher events they produce) don't fire per keystroke.
 */

import { useEffect, useRef } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { FileEntry } from "@/utils/fs";
import {
  getOrCreateWorkspaceCollections,
  writeFileContent,
} from "@/entities/files";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { UI_ONLY_TRANSACTION_META } from "@/components/editor/editor-schema-kit";
import {
  carryDraftsForward,
  isDraftOnlyEdit,
} from "@/components/editor/draft-only-edit";

const AUTOSAVE_DEBOUNCE_MS = 500;

/** The markdown serialization of the current editor document (synchronous,
 * main-thread — kept for tests and one-off callers, not the save path). */
export function getEditorMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as {
      markdown: { getMarkdown: () => string };
    }
  ).markdown.getMarkdown();
}

/**
 * Whether file content differs from the editor's serialization in a way
 * that warrants replacing the document. trimEnd: files conventionally end
 * with a newline that the markdown serializer never emits — that
 * difference alone is not a content change.
 */
export function isExternalContentChange(
  currentMarkdown: string,
  fileContent: string,
): boolean {
  return currentMarkdown.trimEnd() !== fileContent.trimEnd();
}

export function useEditorFileSync(
  editor: Editor,
  file: FileEntry,
  basePath: string,
  isContentLoaded: boolean,
  contentError?: string,
): void {
  const suppressSaveRef = useRef(false);
  // Non-null while edits sit in the debounce window (not yet pushed to the
  // pipeline). Those edits are local state the adoption path must not
  // clobber, and they must be flushed — not dropped — on teardown.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Baseline for external-change comparison. A failed read produces a row
  // with empty content and a synthetic hash — never baseline on that.
  useEffect(() => {
    if (isContentLoaded && !contentError) {
      getDocumentSync(file.path).ensureBaseline(
        file.content ?? "",
        file.contentHash,
      );
    }
  }, [file.path, isContentLoaded, contentError, file.content, file.contentHash]);

  // Disk → editor: adopt external changes.
  useEffect(() => {
    if (!editor || !file.contentHash || contentError) return;

    const sync = getDocumentSync(file.path);
    const fileContent = file.content ?? "";
    if (!sync.needsAdoption(file.contentHash, fileContent)) return;

    let cancelled = false;
    const targetHash = file.contentHash;
    const isCurrentRow = () =>
      getOrCreateWorkspaceCollections(basePath).content.get(file.path)
        ?.contentHash === targetHash;
    // Cheap pre-check: don't parse content the currency check will reject
    // (stale renders under save bursts are the common visitor here).
    if (!isCurrentRow()) return;
    (async () => {
      const doc = await sync.prepareAdoption(fileContent);
      if (!doc || cancelled || editor.isDestroyed) return;
      // Commit-time currency check, in memory — no disk I/O on this path.
      // The row driving this effect is rendered state and can lag: under
      // back-to-back autosaves a render can deliver the PREVIOUS save's
      // row after DocumentSync's baseline advanced (MET-70 deletions/undo/
      // paste "jumping back"). The content collection is the app's
      // freshest belief of the file — our own writes update it before disk
      // persists, and watcher events sync it from a fresh disk read
      // (handleContentFileSystemChange, the one place that reads). So
      // adopt only a row that still IS the collection's current state; a
      // lagging render's newer truth arrives as its own render and re-runs
      // this effect. This is also what lets a user's own `git checkout --`
      // / `git revert` — bytes identical to an old save of ours — come
      // through: the watcher verified it against disk and made it current.
      if (!isCurrentRow()) return;
      // Edits waiting in the autosave debounce window win over external
      // content, same as an in-flight save (checked inside prepareAdoption).
      if (saveTimerRef.current) return;

      console.log(
        `[text-editor] External change detected for ${file.path}, updating editor`,
      );

      suppressSaveRef.current = true;
      // A half-typed prompt is not on disk and must survive the replace.
      editor.commands.setContent(carryDraftsForward(doc, editor.state.doc), {
        emitUpdate: false,
      });
      suppressSaveRef.current = false;
      sync.commitAdoption(fileContent, targetHash);
    })().catch((error) => {
      console.error(
        `[text-editor] Failed to adopt external change for ${file.path}:`,
        error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [editor, file.contentHash, file.content, file.path, contentError]);

  // Editor → disk: debounced autosave into the pipeline.
  useEffect(() => {
    const sync = getDocumentSync(file.path);
    sync.writer = (markdown) => writeFileContent(basePath, file.path, markdown);

    const pushSnapshot = () => {
      sync.pushUpdate(() => editor.state.doc.toJSON() as JSONContent);
    };

    const flushPending = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pushSnapshot();
      }
    };
    // Lets disposeEditor flush the debounce window before destroying the
    // editor — on tab close this cleanup runs too late (editor already
    // destroyed) to do it itself.
    sync.flushPendingEdits = flushPending;

    const handleUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (suppressSaveRef.current) return;
      if (!isContentLoaded) return;
      // UI-only node changes (the aiPrompt keeper) never alter the
      // serialized markdown — saving would only churn the file watcher.
      if (transaction.getMeta(UI_ONLY_TRANSACTION_META)) return;
      // Neither does typing in a prompt widget's draft: it is document
      // content, but the widget serializes to its marker and never renders
      // children. Not a meta, because these transactions come out of
      // ProseMirror's own input handling — see draft-only-edit.ts.
      if (isDraftOnlyEdit(transaction)) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        pushSnapshot();
      }, AUTOSAVE_DEBOUNCE_MS);
    };

    editor.on("update", handleUpdate);

    return () => {
      editor.off("update", handleUpdate);
      if (sync.flushPendingEdits === flushPending) {
        sync.flushPendingEdits = null;
      }
      // Flush rather than drop a pending save: teardown here is a tab
      // switch, layout change or unmount, and the edits are real. (On tab
      // close disposeEditor already flushed via flushPendingEdits and the
      // timer is null by now.)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (!editor.isDestroyed) pushSnapshot();
      }
    };
  }, [editor, file.path, basePath, isContentLoaded]);
}
