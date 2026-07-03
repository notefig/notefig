/**
 * Keeps the editor and the file on disk in sync, in both directions:
 * debounced autosave of editor changes, and adoption of external file
 * changes (detected via contentHash) without clobbering the caret.
 */

import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import type { FileEntry } from "@/utils/fs";
import { writeFileContent } from "@/utils/collections";
import { calculateContentHash } from "@/utils/hash";

const AUTOSAVE_DEBOUNCE_MS = 500;

/** The markdown serialization of the current editor document. */
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
): void {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownHashRef = useRef<string>(file.contentHash || "");
  const suppressSaveRef = useRef(false);

  // Disk → editor: adopt external changes.
  useEffect(() => {
    if (!editor || !file.contentHash) return;

    if (file.contentHash === lastKnownHashRef.current) return;

    // The hash settles (or is recomputed) after mount even when nothing
    // changed. Replacing the doc with identical content would only reset the
    // caret to the document start — mid-typing, if the user is fast.
    if (
      !isExternalContentChange(getEditorMarkdown(editor), file.content ?? "")
    ) {
      lastKnownHashRef.current = file.contentHash;
      return;
    }

    console.log(
      `[text-editor] External change detected for ${file.path}, updating editor`,
    );

    suppressSaveRef.current = true;
    editor.commands.setContent(file.content, { emitUpdate: false });
    suppressSaveRef.current = false;
    lastKnownHashRef.current = file.contentHash;
  }, [editor, file.contentHash, file.content, file.path]);

  // Editor → disk: debounced autosave.
  useEffect(() => {
    const handleUpdate = () => {
      if (suppressSaveRef.current) return;
      if (!isContentLoaded) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        const markdown = getEditorMarkdown(editor);

        const hash = calculateContentHash(markdown);
        lastKnownHashRef.current = hash;

        writeFileContent(basePath, file.path, markdown);
      }, AUTOSAVE_DEBOUNCE_MS);
    };

    editor.on("update", handleUpdate);

    return () => {
      editor.off("update", handleUpdate);
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [editor, file.path, basePath, isContentLoaded]);
}
