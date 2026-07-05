/**
 * Wires an editor to its file's DocumentSync pipeline (see
 * utils/markdown-conversion.ts, which owns all save coalescing, baselines
 * and adoption decisions). This hook only translates editor events into
 * pipeline calls and pipeline results into `setContent`.
 */

import { useEffect, useRef } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { FileEntry } from "@/utils/fs";
import { writeFileContent } from "@/utils/collections";
import { getDocumentSync } from "@/utils/markdown-conversion";

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
    (async () => {
      const doc = await sync.prepareAdoption(fileContent);
      if (!doc || cancelled || editor.isDestroyed) return;

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

  // Editor → disk: ship every update to the pipeline as it happens.
  useEffect(() => {
    const sync = getDocumentSync(file.path);
    sync.writer = (markdown) => writeFileContent(basePath, file.path, markdown);

    const handleUpdate = () => {
      if (suppressSaveRef.current) return;
      if (!isContentLoaded) return;
      sync.pushUpdate(() => editor.state.doc.toJSON() as JSONContent);
    };

    editor.on("update", handleUpdate);

    return () => {
      editor.off("update", handleUpdate);
    };
  }, [editor, file.path, basePath, isContentLoaded]);
}
