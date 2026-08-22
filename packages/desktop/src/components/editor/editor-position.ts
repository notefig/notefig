/**
 * Pure resolution of a search match to a ProseMirror selection.
 *
 * Raw file line/columns are deliberately NOT inputs: the document doesn't
 * contain the disk file's bytes (frontmatter, hard-wrapped paragraphs,
 * punctuation the serializer would normalize), so no mapping from raw
 * coordinates can be exact. What a search match reliably carries is the
 * matched text, the content of the line it sat on, and which same-text
 * occurrence in the file it was — all of which CAN be located in the
 * rendered document:
 *
 *   1. Collect every occurrence of matchText in the rendered text.
 *   2. Keep the ones whose rendered line best resembles lineText.
 *   3. Break ties (identical lines) with the occurrence index.
 *
 * If the text exists only in the raw bytes (e.g. inside a link URL), the
 * caret lands at the start of the most lineText-similar line instead.
 *
 * All positions come from a single walk of the document that records the
 * exact ProseMirror position of every rendered character — newlines
 * inside code blocks are real characters, block boundaries are not.
 */

import type { SearchTarget } from "@/adapters/platform-adapter.interface";

export type { SearchTarget };

interface DocLike {
  content: { size: number };
  descendants: (fn: (node: unknown, pos: number) => boolean | void) => void;
}

/**
 * One rendered line of the document: its visible text and the ProseMirror
 * document position of every character. `blockPos` is the position inside
 * the (possibly empty) line, used when the line has no characters.
 */
export interface RenderedLine {
  text: string;
  charPos: number[];
  blockPos: number;
}

/**
 * Walk the document once and split it into rendered lines. Every textblock
 * starts a new line; literal "\n" characters inside a textblock (code
 * blocks) also start a new line, exactly like the on-screen layout.
 */
export function buildRenderedLines(doc: DocLike): RenderedLine[] {
  const lines: RenderedLine[] = [];
  let current: RenderedLine | null = null;

  doc.descendants((node: unknown, pos: number) => {
    const n = node as {
      isText?: boolean;
      isTextblock?: boolean;
      text?: string;
    };

    if (n.isTextblock) {
      current = { text: "", charPos: [], blockPos: pos + 1 };
      lines.push(current);
      return;
    }

    if (n.isText && typeof n.text === "string" && current) {
      for (let i = 0; i < n.text.length; i++) {
        const ch = n.text[i];
        if (ch === "\n") {
          current = { text: "", charPos: [], blockPos: pos + i + 1 };
          lines.push(current);
        } else {
          current.text += ch;
          current.charPos.push(pos + i);
        }
      }
    }
  });

  return lines;
}

/** Doc position of `offset` within a line, clamped to the line's end. */
function posInLine(line: RenderedLine, offset: number): number {
  if (offset >= 0 && offset < line.charPos.length) return line.charPos[offset];
  if (line.charPos.length > 0) {
    return line.charPos[line.charPos.length - 1] + 1;
  }
  return line.blockPos;
}

/**
 * Doc position of a character offset in the joined rendered text
 * (lines joined with "\n").
 */
function posAtRenderedOffset(lines: RenderedLine[], offset: number): number {
  let remaining = offset;
  for (const line of lines) {
    if (remaining <= line.text.length) return posInLine(line, remaining);
    remaining -= line.text.length + 1;
  }
  const last = lines[lines.length - 1];
  return posInLine(last, last.text.length);
}

/** Rendered line index containing a character offset in the joined text. */
export function lineIndexAtOffset(
  lines: RenderedLine[],
  offset: number,
): number {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].text.length) return i;
    remaining -= lines[i].text.length + 1;
  }
  return lines.length - 1;
}

/** All offsets of `needle` in `haystack`. */
function allOffsetsOf(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    offsets.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return offsets;
}

/**
 * How much does a rendered line look like the raw file line a search match
 * came from? 1 for equality and for a table cell of the raw row (a row
 * renders one line per cell, so a cell only ever holds a fraction of the
 * row's words); containment scores by the contained share so a trivially
 * short line can't outrank the real one; otherwise the share of the raw
 * line's words present in the rendered line, scaled to stay below the
 * exact tiers. Robust to disk bytes the serializer would normalize
 * (wrapping, punctuation, syntax).
 */
function lineSimilarity(rawLine: string, renderedLine: string): number {
  const raw = rawLine.trim();
  const r = renderedLine.trim();
  if (!raw || !r) return 0;
  if (raw === r) return 1;

  if (raw.includes("|")) {
    const segments = raw.split("|").map((s) => s.trim());
    if (segments.includes(r)) return 1;
  }

  let score = 0;
  if (raw.includes(r)) score = r.length / raw.length;
  if (r.includes(raw)) score = Math.max(score, raw.length / r.length);

  const words = raw.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (words.length > 0) {
    const hits = words.filter((w) => r.includes(w)).length;
    score = Math.max(score, (hits / words.length) * 0.95);
  }
  return score;
}

/**
 * Resolve a search match to a ProseMirror selection range.
 * Collapses to a caret on the most similar line when the matched text has
 * no rendered occurrence (raw-only text such as link URLs).
 */
export function resolveSearchTarget(
  doc: DocLike,
  target: SearchTarget,
): { from: number; to: number } {
  const lines = buildRenderedLines(doc);
  if (lines.length === 0) return { from: 1, to: 1 };

  const rendered = lines.map((l) => l.text).join("\n");
  const occurrences = allOffsetsOf(rendered, target.matchText);

  if (occurrences.length === 0) {
    // Raw-only match: caret at the start of the line that best resembles
    // the raw line the match came from.
    let bestLine = 0;
    let bestScore = 0;
    lines.forEach((line, i) => {
      const s = lineSimilarity(target.lineText, line.text);
      if (s > bestScore) {
        bestScore = s;
        bestLine = i;
      }
    });
    const pos = posInLine(lines[bestLine], 0);
    return { from: pos, to: pos };
  }

  // Keep the occurrences whose rendered line best resembles lineText,
  // then break ties (identical lines, repeated table cells) with the
  // occurrence index. `occurrence` is file-global, so compare against
  // each candidate's position among ALL rendered occurrences — indexing
  // the narrowed subset directly would shift after any exclusion.
  const scored = occurrences.map((o, index) => ({
    o,
    index,
    s: lineSimilarity(target.lineText, lines[lineIndexAtOffset(lines, o)].text),
  }));
  const best = Math.max(...scored.map((x) => x.s));
  const candidates = scored.filter((x) => x.s === best);
  const chosen = candidates.reduce((a, b) =>
    Math.abs(b.index - target.occurrence) < Math.abs(a.index - target.occurrence)
      ? b
      : a,
  ).o;

  return {
    from: posAtRenderedOffset(lines, chosen),
    to: posAtRenderedOffset(lines, chosen + target.matchText.length - 1) + 1,
  };
}

/**
 * Find-in-document: every occurrence of `query` in the rendered text, in the
 * `SearchTarget` shape `resolveSearchTarget` reads back. Occurrence indices
 * are counted per distinct matched text (a case-insensitive search can match
 * several spellings), which is exactly how the workspace-wide file search
 * numbers its matches.
 */
export function searchRenderedDoc(
  doc: DocLike,
  query: string,
  options: { caseSensitive?: boolean } = {},
): SearchTarget[] {
  if (!query) return [];

  const lines = buildRenderedLines(doc);
  const rendered = lines.map((l) => l.text).join("\n");
  const haystack = options.caseSensitive ? rendered : rendered.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];

  const seen = new Map<string, number>();
  const matches: SearchTarget[] = [];

  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const matchText = rendered.slice(idx, idx + needle.length);
    const occurrence = seen.get(matchText) ?? 0;
    seen.set(matchText, occurrence + 1);
    matches.push({
      matchText,
      lineText: lines[lineIndexAtOffset(lines, idx)].text,
      occurrence,
    });
    idx = haystack.indexOf(needle, idx + 1);
  }

  return matches;
}
