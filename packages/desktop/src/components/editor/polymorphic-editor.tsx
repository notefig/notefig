"use client";

import { Suspense } from "react";
import type { FileEntry } from "@/utils/fs";
import { TextEditor } from "./text-editor";
import { ImageViewer } from "./image-viewer";
import { FileLoadingPlaceholder } from "./file-loading-placeholder";
import { getFileExtension, isTextFile } from "@/utils/fs";

export type EditorType = "markdown" | "image";

interface PolymorphicEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
}

const imageExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);

/**
 * Determine the editor type for a given file path.
 * All non-image files are treated as markdown.
 */
export function getEditorType(filePath: string): EditorType {
  if (imageExtensions.has(getFileExtension(filePath))) {
    return "image";
  }
  return "markdown";
}

/**
 * Check if a file can be opened in the editor.
 * Images get the image viewer, known text files get the markdown editor,
 * unknown/binary files are refused.
 */
export function canOpenFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  if (!ext) return true;
  if (imageExtensions.has(ext)) return true;
  return isTextFile(filePath);
}

/**
 * Inner component that assumes content is loaded.
 * Suspended by parent Suspense boundary during loading.
 */
function PolymorphicEditorInner({
  file,
  basePath,
  isContentLoaded,
}: PolymorphicEditorProps) {
  const editorType = getEditorType(file.path);

  if (editorType === "image") {
    return <ImageViewer file={file} basePath={basePath} />;
  }

  return (
    <TextEditor
      file={file}
      basePath={basePath}
      isContentLoaded={isContentLoaded}
    />
  );
}

/**
 * Polymorphic editor that renders the appropriate editor based on file type.
 * File data (metadata + content) is loaded by the parent Workspace component.
 * Uses Suspense to show loading state while content is being fetched.
 */
export function PolymorphicEditor({
  file,
  basePath,
  isContentLoaded,
}: PolymorphicEditorProps) {
  return (
    <Suspense fallback={<FileLoadingPlaceholder filePath={file.path} />}>
      <PolymorphicEditorInner
        file={file}
        basePath={basePath}
        isContentLoaded={isContentLoaded}
      />
    </Suspense>
  );
}
