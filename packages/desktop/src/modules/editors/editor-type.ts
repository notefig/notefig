/**
 * Which editor a file opens in, and whether it opens at all: the format
 * gate tabs, the palette and the prompt's file picker share.
 */
import { getFileExtension, isImageFile, isTextFile } from "@/utils/fs";
import type { EditorType } from "./editors";

/**
 * Extensions that open in the editable markdown editor. Everything else
 * that passes `isTextFile` opens in the read-only code viewer: the markdown
 * codec is the app's only write path, and round-tripping a code/config file
 * through it rewrites the file (escaping, trailing-whitespace fixups) —
 * read-only rendering is the honest mode for those. Plain-text files stay
 * editable: they're plausibly notes, and the codec keeps them intact enough.
 */
const markdownEditableExtensions = new Set([
  "md",
  "markdown",
  "mdown",
  "mkd",
  "txt",
  "text",
]);

/**
 * Determine the editor type for a given file path.
 */
export function getEditorType(filePath: string): EditorType {
  if (isImageFile(filePath)) return "image";
  const extension = getFileExtension(filePath);
  return markdownEditableExtensions.has(extension) ? "markdown" : "code";
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
