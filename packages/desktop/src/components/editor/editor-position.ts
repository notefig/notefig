/**
 * Position mapping between line/column text coordinates and ProseMirror
 * document positions, plus location resolution for editor navigation
 * (search results, go-to-line).
 */

import { fuzzyFind } from "@/utils/navigation-utils";

/**
 * Location for editor navigation.
 * Mirrors SearchMatchLocation from search results.
 */
export interface EditorLocation {
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed, optional - defaults to 1) */
  column?: number;
  /** Expected text at location for verification/fuzzy matching */
  expectedText?: string;
  /** Selection range end line (for multi-line selections) */
  endLine?: number;
  /** Selection range end column */
  endColumn?: number;
}

interface DocLike {
  content: { size: number };
  textBetween: (
    from: number,
    to: number,
    blockSeparator?: string,
    leafText?: string,
  ) => string;
  descendants: (fn: (node: unknown, pos: number) => boolean | void) => void;
}

export function resolveLineColumn(
  doc: { content: { size: number } },
  text: string,
  line: number,
  column: number,
): number {
  const lines = text.split("\n");
  let pos = 1;

  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }

  const lineContent = lines[line - 1] ?? "";
  pos += Math.min(column - 1, lineContent.length);

  return Math.max(1, Math.min(pos, doc.content.size));
}

/**
 * Map a 0-indexed character offset in the document's visible text to a
 * 1-indexed ProseMirror document position. ProseMirror positions include
 * node-boundary tokens that sit before the text content, so offset + 1 is
 * not sufficient. We walk the text descendants to find the correct position.
 */
export function textOffsetToDocPos(
  doc: {
    content: { size: number };
    descendants: (fn: (node: unknown, pos: number) => boolean | void) => void;
  },
  targetOffset: number,
): number {
  let accumulated = 0;

  let result = 1;
  doc.descendants((node: unknown, pos: number) => {
    const n = node as { isText?: boolean; text?: string; nodeSize?: number };
    if (!n.isText || typeof n.text !== "string") return;

    const len = n.text.length;
    if (targetOffset < accumulated + len) {
      result = pos + (targetOffset - accumulated);
      return false; // stop traversal
    }
    accumulated += len;
  });

  return Math.max(1, Math.min(result, doc.content.size));
}

/**
 * Map an offset in the block-separated full text (textBetween with "\n"
 * separators) to an offset in the concatenated text-node stream, by
 * discounting the separator characters before it.
 */
export function fullTextOffsetToTextOffset(
  fullText: string,
  offset: number,
): number {
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (fullText[i] === "\n") count++;
  }
  return offset - count;
}

/**
 * Resolve an EditorLocation to a ProseMirror selection range. Prefers a
 * fuzzy match on expectedText (search results) over raw line/column, and
 * supports explicit end coordinates for multi-line selections.
 */
export function resolveEditorLocation(
  doc: DocLike,
  location: EditorLocation,
): { from: number; to: number } {
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n");
  let from = resolveLineColumn(
    doc,
    fullText,
    location.line,
    location.column ?? 1,
  );
  let to = from;

  if (location.expectedText) {
    const fuzzyOffset = fuzzyFind(fullText, location.expectedText, from - 1);
    if (fuzzyOffset !== -1) {
      const textStart = fullTextOffsetToTextOffset(fullText, fuzzyOffset);
      const textEnd = fullTextOffsetToTextOffset(
        fullText,
        fuzzyOffset + location.expectedText.length,
      );
      from = textOffsetToDocPos(doc, textStart);
      to = textOffsetToDocPos(doc, textEnd - 1) + 1;
    }
  } else if (
    location.endLine !== undefined &&
    location.endColumn !== undefined
  ) {
    to = resolveLineColumn(doc, fullText, location.endLine, location.endColumn);
  }

  return { from, to };
}
