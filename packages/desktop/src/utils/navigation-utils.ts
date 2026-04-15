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
