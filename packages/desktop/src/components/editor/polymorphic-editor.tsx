"use client";

import type { FileEntry } from "@/utils/fs";
import { TextEditor } from "./text-editor";
import { ImageViewer } from "./image-viewer";
import { FileLoadingPlaceholder } from "./file-loading-placeholder";
import { hasEditor } from "@/components/editor/editor-store";
import { getFileExtension, isImageFile, isTextFile } from "@/utils/fs";

export type EditorType = "markdown" | "image";

interface PolymorphicEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
  /** Set when the content read failed — file.content is NOT the real content. */
  contentError?: string;
}

/**
 * Determine the editor type for a given file path.
 * All non-image files are treated as markdown.
 */
export function getEditorType(filePath: string): EditorType {
  return isImageFile(filePath) ? "image" : "markdown";
}

/**
 * Check if a file can be opened in the editor.
 * Images get the image viewer, known text files get the markdown editor,
 * unknown/binary files are refused.
 */
export function canOpenFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  if (!ext) return true;
  if (isImageFile(filePath)) return true;
  return isTextFile(filePath);
}

/**
 * Polymorphic editor that renders the appropriate editor based on file type.
 * File data (metadata + content) is loaded by the parent Workspace component.
 *
 * The text editor is not mounted until content has loaded: creating the
 * Tiptap instance with empty content would let the user type into a blank
 * doc that gets replaced when the real content arrives, and risks
 * persisting an empty document. Once an editor instance exists it stays
 * mounted even if isContentLoaded flips back to false transiently, so
 * focus and caret survive content refetches.
 */
export function PolymorphicEditor({
  file,
  basePath,
  isContentLoaded,
  contentError,
}: PolymorphicEditorProps) {
  const editorType = getEditorType(file.path);

  if (editorType === "image") {
    return <ImageViewer file={file} basePath={basePath} />;
  }

  // A failed read still produces a content row (with empty content), so it
  // must be checked before isContentLoaded: mounting an editor on it would
  // let an autosave overwrite the real file with an empty document.
  if (contentError && !hasEditor(file.path)) {
    return <FileLoadingPlaceholder filePath={file.path} error={contentError} />;
  }

  if (!isContentLoaded && !hasEditor(file.path)) {
    return <FileLoadingPlaceholder filePath={file.path} />;
  }

  return (
    <TextEditor
      file={file}
      basePath={basePath}
      isContentLoaded={isContentLoaded}
      contentError={contentError}
    />
  );
}
