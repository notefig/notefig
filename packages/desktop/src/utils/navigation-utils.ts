/**
 * Editor Navigation Utilities
 *
 * Pure functions for converting between line/column coordinates and offsets.
 * These are extracted to a separate file for easier testing.
 */

/**
 * Find the closest occurrence of search text to a preferred offset.
 * Returns -1 if not found.
 */
export function fuzzyFind(
  text: string,
  search: string,
  preferredOffset: number,
): number {
  let bestOffset = -1;
  let bestDistance = Infinity;

  let idx = text.indexOf(search);
  while (idx !== -1) {
    const distance = Math.abs(idx - preferredOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = idx;
    }
    idx = text.indexOf(search, idx + 1);
  }

  return bestOffset;
}

/**
 * Convert line/column (1-indexed) to absolute offset in text content.
 */
export function lineColumnToTextareaOffset(
  content: string,
  line: number,
  column: number,
): number {
  const lines = content.split("\n");
  let offset = 0;

  // Add length of all previous lines (including their newlines)
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }

  // Add column offset for current line (clamped to line length)
  if (line <= lines.length) {
    const lineContent = lines[line - 1] ?? "";
    offset += Math.min(column - 1, lineContent.length);
  }

  return Math.max(0, offset);
}

/**
 * Convert a 1-indexed column to a 0-indexed text offset.
 * Clamps to valid range.
 *
 * @param textLength - Length of the text content
 * @param column - 1-indexed column number
 */
export function columnToOffset(textLength: number, column: number): number {
  // Column is 1-indexed, offset is 0-indexed
  const offset = Math.max(0, column - 1);
  // Clamp to text length
  return Math.min(offset, textLength);
}

// ---------------------------------------------------------------------------
// Raw markdown line → Slate AST path mapping
// ---------------------------------------------------------------------------

/**
 * Minimal block shape needed for line mapping. Matches Plate AST nodes
 * without requiring Slate/Plate imports.
 */
export interface BlockNode {
  type?: string;
  children?: BlockNode[];
  indent?: number;
  listStyleType?: string;
  lang?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Result of mapping a raw markdown line number to a Slate path.
 */
export interface LineMapping {
  /** Slate path to the most specific navigable node */
  path: number[];
  /** Index of the top-level block */
  blockIndex: number;
  /** True if the line is a code fence (``` line) — not navigable content */
  isFenceLine: boolean;
  /** True if the line is a table separator (| --- | --- |) */
  isSeparatorLine: boolean;
}

/**
 * Check whether a block node is a list item (has indent-based list properties).
 */
function isListItem(block: BlockNode): boolean {
  return block.listStyleType !== undefined && block.indent !== undefined;
}

/**
 * Check whether two adjacent blocks belong to the same list group
 * (no blank line separator between them).
 *
 * Same list group = both are list items with the same listStyleType.
 */
function isSameListGroup(a: BlockNode, b: BlockNode): boolean {
  return isListItem(a) && isListItem(b) && a.listStyleType === b.listStyleType;
}

/**
 * Count how many markdown lines a single top-level block produces
 * (excluding blank-line separators).
 */
function blockLineCount(block: BlockNode): number {
  const type = block.type;

  if (type === "code_block") {
    // Opening fence + N code_lines + closing fence
    const codeLines = block.children?.filter(
      (c) => (c as BlockNode).type === "code_line",
    );
    return 2 + (codeLines?.length ?? 0);
  }

  if (type === "table") {
    // Header row + separator line + data rows
    const rows = block.children?.filter((c) => (c as BlockNode).type === "tr");
    const rowCount = rows?.length ?? 0;
    // 1 separator line after the first row (header)
    return rowCount > 0 ? rowCount + 1 : 0;
  }

  // All other blocks (p, h1-h6, blockquote, img, hr, etc.) = 1 line
  return 1;
}

/**
 * Map a raw markdown file line number (1-indexed) to a Slate AST path.
 *
 * This uses heuristic line counting based on block types:
 * - p, h1-h6, blockquote, img, hr: 1 line each
 * - code_block: 2 (fences) + N code_lines
 * - table: N rows + 1 separator
 * - Blank line between every pair of top-level blocks, EXCEPT between
 *   consecutive list items with the same listStyleType
 *
 * @param blocks - The editor's top-level children (editor.children)
 * @param rawLine - 1-indexed line number from the raw markdown file
 * @returns LineMapping with the Slate path, or null if out of range
 */
export function rawLineToBlockPath(
  blocks: BlockNode[],
  rawLine: number,
): LineMapping | null {
  if (rawLine < 1 || blocks.length === 0) return null;

  let currentLine = 1; // tracks which raw line we're at

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const lines = blockLineCount(block);
    const blockStartLine = currentLine;
    const blockEndLine = currentLine + lines - 1;

    if (rawLine >= blockStartLine && rawLine <= blockEndLine) {
      // The target line is within this block
      const lineWithinBlock = rawLine - blockStartLine; // 0-indexed

      if (block.type === "code_block") {
        if (lineWithinBlock === 0) {
          // Opening fence
          return {
            path: [i],
            blockIndex: i,
            isFenceLine: true,
            isSeparatorLine: false,
          };
        }
        if (lineWithinBlock === lines - 1) {
          // Closing fence
          return {
            path: [i],
            blockIndex: i,
            isFenceLine: true,
            isSeparatorLine: false,
          };
        }
        // Code content line — navigate to specific code_line child
        const codeLineIndex = lineWithinBlock - 1; // -1 for opening fence
        return {
          path: [i, codeLineIndex],
          blockIndex: i,
          isFenceLine: false,
          isSeparatorLine: false,
        };
      }

      if (block.type === "table") {
        const rows = block.children?.filter(
          (c) => (c as BlockNode).type === "tr",
        );
        if (lineWithinBlock === 1) {
          // Separator line (| --- | --- |)
          return {
            path: [i],
            blockIndex: i,
            isFenceLine: false,
            isSeparatorLine: true,
          };
        }
        // Map to the correct row
        // Line 0 = header row (rows[0]), line 1 = separator, line 2+ = data rows
        let rowIndex: number;
        if (lineWithinBlock === 0) {
          rowIndex = 0;
        } else {
          rowIndex = lineWithinBlock - 1; // -1 for separator
        }
        if (rows && rowIndex < rows.length) {
          return {
            path: [i],
            blockIndex: i,
            isFenceLine: false,
            isSeparatorLine: false,
          };
        }
      }

      if (block.type === "blockquote") {
        // Navigate to the inner paragraph
        return {
          path: [i, 0],
          blockIndex: i,
          isFenceLine: false,
          isSeparatorLine: false,
        };
      }

      // Simple block (p, h1-h6, img, hr, etc.)
      return {
        path: [i],
        blockIndex: i,
        isFenceLine: false,
        isSeparatorLine: false,
      };
    }

    // Move past this block
    currentLine += lines;

    // Add blank line separator after this block (unless next block is same list group)
    const nextBlock = blocks[i + 1];
    if (nextBlock && !isSameListGroup(block, nextBlock)) {
      currentLine += 1; // blank separator line
    }
  }

  return null; // line is beyond the document
}
