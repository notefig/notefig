/**
 * Pure ProseMirror doc helpers for widget-context resources — no React, no
 * agent dependency. Used both to build the surrounding-text window served
 * over `resources/read` (widget-context-resource.ts) and by anything else
 * that needs a document's heading outline.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

export interface DocHeading {
  level: number;
  text: string;
  pos: number;
}

/** Every heading in the doc, in document order. */
export function extractOutline(doc: PMNode): DocHeading[] {
  const headings: DocHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({
        level: (node.attrs.level as number) ?? 1,
        text: node.textContent,
        pos,
      });
    }
    return true;
  });
  return headings;
}

/** The nearest heading at or before `pos` (null if none, e.g. `pos` is
 *  above the first heading or the doc has no headings). */
export function nearestPrecedingHeading(
  doc: PMNode,
  pos: number,
): DocHeading | null {
  const outline = extractOutline(doc);
  let nearest: DocHeading | null = null;
  for (const heading of outline) {
    if (heading.pos > pos) break;
    nearest = heading;
  }
  return nearest;
}

/**
 * A character window centered on `pos`, bounded to `maxChars` total (split
 * before/after), clamped to the doc's actual content size. Plain
 * `doc.textBetween` slice — no relocation, no fuzzy matching: `pos` is
 * used exactly as given by the caller.
 */
export function windowAroundPos(
  doc: PMNode,
  pos: number,
  maxChars = 2000,
): string {
  const size = doc.content.size;
  const clamped = Math.max(0, Math.min(pos, size));
  const half = Math.floor(maxChars / 2);
  const from = Math.max(0, clamped - half);
  const to = Math.min(size, clamped + half);
  return doc.textBetween(from, to, "\n", "\n");
}
