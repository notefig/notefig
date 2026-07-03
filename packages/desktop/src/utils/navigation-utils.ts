/**
 * Editor Navigation Utilities
 *
 * Pure functions for editor navigation. The line/column ↔ ProseMirror
 * position math lives in components/editor/editor-position.ts.
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
