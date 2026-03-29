"use client";

import { Suspense } from "react";
import type { FileEntry } from "@/utils/fs";
import { TextEditor } from "./text-editor";
import { CodeEditor } from "./code-editor";
import { ImageViewer } from "./image-viewer";
import { FileLoadingPlaceholder } from "./file-loading-placeholder";
import { getFileExtension } from "@/utils/fs";

export type EditorType = "markdown" | "code" | "image";

interface PolymorphicEditorProps {
  file: FileEntry;
  basePath: string;
}

/**
 * Determine the editor type for a given file path.
 */
export function getEditorType(filePath: string): EditorType {
  const extension = getFileExtension(filePath);

  // Image files
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
  if (imageExtensions.has(extension)) {
    return "image";
  }

  // Markdown files
  const markdownExtensions = new Set(["md", "markdown", "mdown", "mkd"]);
  if (markdownExtensions.has(extension)) {
    return "markdown";
  }

  // All other text files use code editor
  return "code";
}

/**
 * Check if a file can be opened in an editor.
 */
export function canOpenFile(filePath: string): boolean {
  const type = getEditorType(filePath);
  return type !== null;
}

/**
 * Inner component that assumes content is loaded.
 * Suspended by parent Suspense boundary during loading.
 */
function PolymorphicEditorInner({ file, basePath }: PolymorphicEditorProps) {
  const editorType = getEditorType(file.path);

  switch (editorType) {
    case "markdown":
      return <TextEditor file={file} basePath={basePath} />;
    case "code":
      return <CodeEditor file={file} basePath={basePath} />;
    case "image":
      return <ImageViewer file={file} basePath={basePath} />;
    default:
      return <CodeEditor file={file} basePath={basePath} />;
  }
}

/**
 * Polymorphic editor that renders the appropriate editor based on file type.
 * File data (metadata + content) is loaded by the parent Workspace component.
 * Uses Suspense to show loading state while content is being fetched.
 */
export function PolymorphicEditor({ file, basePath }: PolymorphicEditorProps) {
  return (
    <Suspense fallback={<FileLoadingPlaceholder filePath={file.path} />}>
      <PolymorphicEditorInner file={file} basePath={basePath} />
    </Suspense>
  );
}
