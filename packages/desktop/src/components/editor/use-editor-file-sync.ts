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
import { writeFileContent } from "@/utils/collections";
import { isRecentSelfWrite } from "@/utils/file-sync";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { UI_ONLY_TRANSACTION_META } from "@/components/editor/editor-schema-kit";

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

    // A file state this app wrote itself is never an external change — the
    // editor already moved past it. Under back-to-back autosaves a render
    // can deliver the PREVIOUS save's row after DocumentSync's baseline has
    // advanced to the next one; without this guard that stale row passes
    // needsAdoption (hashes differ) and, once the in-flight save settles,
    // setContent rolls the editor back to it (MET-70: deletions/undo/paste
    // "jumping back"). Same ledger the watcher path consults in
    // handleContentFileSystemChange.
    if (isRecentSelfWrite(file.path, file.contentHash)) return;

    const sync = getDocumentSync(file.path);
    const fileContent = file.content ?? "";
    if (!sync.needsAdoption(file.contentHash, fileContent)) return;

    let cancelled = false;
    const targetHash = file.contentHash;
    (async () => {
      const doc = await sync.prepareAdoption(fileContent);
      if (!doc || cancelled || editor.isDestroyed) return;
      // Edits waiting in the autosave debounce window win over external
      // content, same as an in-flight save (checked inside prepareAdoption).
      if (saveTimerRef.current) return;

      console.log(
        `[text-editor] External change detected for ${file.path}, updating editor`,
      );

      suppressSaveRef.current = true;
      editor.commands.setContent(doc, { emitUpdate: false });
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

    const handleUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (suppressSaveRef.current) return;
      if (!isContentLoaded) return;
      // UI-only node changes (the aiPrompt keeper) never alter the
      // serialized markdown — saving would only churn the file watcher.
      if (transaction.getMeta(UI_ONLY_TRANSACTION_META)) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        pushSnapshot();
      }, AUTOSAVE_DEBOUNCE_MS);
    };

    editor.on("update", handleUpdate);

    return () => {
      editor.off("update", handleUpdate);
      // Flush rather than drop a pending save: teardown here is a tab
      // switch, layout change or unmount, and the edits are real.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (!editor.isDestroyed) pushSnapshot();
      }
    };
  }, [editor, file.path, basePath, isContentLoaded]);
}
