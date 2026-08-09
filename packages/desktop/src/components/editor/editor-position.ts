/**
 * Position mapping between raw-markdown text coordinates and ProseMirror
 * document positions, plus location resolution for editor navigation
 * (search results, go-to-line).
 *
 * Search (searchFileContent / search.rs) reports 1-indexed line/columns
 * against the RAW markdown file. The rendered document has a different
 * shape: syntax prefixes, blank lines, fences and table delimiter rows
 * exist only in the raw file, while table cells expand to one rendered
 * line each. Resolution therefore works in three tiers:
 *
 *  1. expectedText + raw markdown → occurrence-index match: count which
 *     occurrence of the matched text the raw coordinates point at, then
 *     select the same occurrence in the rendered text. Exact for every
 *     repeated-term case.
 *  2. expectedText without a usable raw offset → nearest occurrence to
 *     the aligned line hint.
 *  3. No expectedText (plain go-to-line), or text that only exists in the
 *     raw file (link URLs) → align raw lines to rendered lines and map
 *     line/column through the alignment.
 *
 * All doc positions come from a single walk of the document that records
 * the exact ProseMirror position of every rendered character — newlines
 * inside code blocks are real characters, block boundaries are not.
 */

/**
 * Location for editor navigation.
 * Mirrors SearchMatchLocation from search results.
 */
export interface EditorLocation {
  /** Line number in the raw markdown file (1-indexed) */
  line: number;
  /** Column number in the raw markdown file (1-indexed, defaults to 1) */
  column?: number;
  /** Expected text at location for verification/occurrence matching */
  expectedText?: string;
  /**
   * Raw content of the line containing the match (search results).
   * Primary disambiguator between occurrences of expectedText — it works
   * even when the disk file's bytes differ from the doc's serialization.
   */
  lineText?: string;
  /**
   * 0-indexed occurrence of expectedText among all search matches with the
   * same text in this file. Tie-break when lineText can't disambiguate
   * (identical lines).
   */
  occurrence?: number;
  /** Selection range end line (for multi-line selections) */
  endLine?: number;
  /** Selection range end column */
  endColumn?: number;
}

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

/** Character offset of the start of rendered line `li` in the joined text. */
function renderedLineStartOffset(lines: RenderedLine[], li: number): number {
  let offset = 0;
  for (let i = 0; i < li && i < lines.length; i++) {
    offset += lines[i].text.length + 1;
  }
  return offset;
}

/**
 * Does rendered line text `rendered` plausibly come from raw markdown line
 * `raw`? True for exact/prefix-stripped lines (headings, quotes, list
 * items, code lines — the rendered text is a substring of the raw line),
 * table cells (a `|`-delimited segment), and inline-formatted lines where
 * markdown syntax breaks up the text (majority word overlap).
 */
function lineMatchesRaw(raw: string, rendered: string): boolean {
  const r = rendered.trim();
  if (!r) return false;
  if (raw.includes(r)) return true;

  if (raw.includes("|")) {
    const segments = raw.split("|").map((s) => s.trim());
    if (segments.includes(r)) return true;
  }

  const words = r.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const hits = words.filter((w) => raw.includes(w)).length;
  return hits >= Math.ceil(words.length / 2);
}

/**
 * Monotone greedy alignment of raw markdown lines to rendered lines.
 * Returns, for each raw line, the index of its first rendered line, or
 * null for raw-only lines (blanks, fences, table delimiter rows).
 * A table row consumes all of its cells' rendered lines.
 */
export function alignRawLinesToRendered(
  rawLines: string[],
  lines: RenderedLine[],
): (number | null)[] {
  const map: (number | null)[] = new Array(rawLines.length).fill(null);

  const nextNonEmpty = (i: number): number => {
    while (i < lines.length && lines[i].text.trim() === "") i++;
    return i;
  };

  let ri = 0;
  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li];
    if (raw.trim() === "") continue;

    ri = nextNonEmpty(ri);
    if (ri >= lines.length) break;

    if (!lineMatchesRaw(raw, lines[ri].text)) continue;

    map[li] = ri;
    ri++;

    // A table row renders one line per cell — consume the remaining cells.
    if (raw.includes("|")) {
      const segments = raw.split("|").map((s) => s.trim());
      let rj = nextNonEmpty(ri);
      while (rj < lines.length && segments.includes(lines[rj].text.trim())) {
        ri = rj + 1;
        rj = nextNonEmpty(ri);
      }
    }
  }

  return map;
}

/** Absolute character offset of raw (line, column) in the raw markdown. */
function rawLineColumnToOffset(
  rawLines: string[],
  line: number,
  column: number,
): number {
  let offset = 0;
  for (let i = 0; i < line - 1 && i < rawLines.length; i++) {
    offset += rawLines[i].length + 1;
  }
  const lineContent = rawLines[line - 1] ?? "";
  return offset + Math.min(Math.max(column - 1, 0), lineContent.length);
}

/**
 * Map raw (line, column) to a rendered line index + offset within it.
 * With raw markdown available, uses the line alignment and an anchored
 * suffix search for the column (longest suffix of the raw line starting at
 * `column` that appears in the rendered line). Without it, treats the
 * coordinates as rendered-text coordinates directly.
 */
function mapRawLineColumn(
  lines: RenderedLine[],
  line: number,
  column: number,
  rawMarkdown?: string,
): { li: number; offset: number } {
  const clampLine = (i: number) =>
    Math.min(Math.max(i, 0), Math.max(lines.length - 1, 0));

  if (rawMarkdown === undefined) {
    const li = clampLine(line - 1);
    const offset = Math.min(Math.max(column - 1, 0), lines[li].text.length);
    return { li, offset };
  }

  const rawLines = rawMarkdown.split("\n");
  const map = alignRawLinesToRendered(rawLines, lines);
  const rawIdx = Math.min(Math.max(line - 1, 0), rawLines.length - 1);

  // Nearest aligned raw line: exact, then forward, then backward.
  let li: number | null = map[rawIdx] ?? null;
  if (li === null) {
    for (let d = 1; d < rawLines.length && li === null; d++) {
      li = map[rawIdx + d] ?? map[rawIdx - d] ?? null;
    }
  }
  if (li === null) li = clampLine(line - 1);

  const rawLine = rawLines[rawIdx] ?? "";
  const lineText = lines[li].text;

  if (column - 1 >= rawLine.length) {
    return { li, offset: lineText.length };
  }

  // Anchored suffix search: the target character stays the first character
  // of the needle while markdown syntax after it shrinks away.
  let needle = rawLine.slice(Math.max(column - 1, 0));
  while (needle.length > 0) {
    const at = lineText.indexOf(needle);
    if (at !== -1) return { li, offset: at };
    needle = needle.slice(0, -1);
  }
  return { li, offset: 0 };
}

/**
 * Resolve an EditorLocation to a ProseMirror selection range.
 * `rawMarkdown` is the document's markdown serialization (the same
 * coordinate space the search backend reported line/column in).
 */
export function resolveEditorLocation(
  doc: DocLike,
  location: EditorLocation,
  rawMarkdown?: string,
): { from: number; to: number } {
  const lines = buildRenderedLines(doc);
  if (lines.length === 0) return { from: 1, to: 1 };

  const rendered = lines.map((l) => l.text).join("\n");
  const column = location.column ?? 1;

  if (location.expectedText) {
    const selection = resolveByExpectedText(lines, rendered, location, rawMarkdown);
    if (selection) return selection;
  }

  const start = mapRawLineColumn(lines, location.line, column, rawMarkdown);
  const from = posInLine(lines[start.li], start.offset);
  let to = from;

  if (location.endLine !== undefined && location.endColumn !== undefined) {
    const end = mapRawLineColumn(
      lines,
      location.endLine,
      location.endColumn,
      rawMarkdown,
    );
    to = Math.max(from, posInLine(lines[end.li], end.offset));
  }

  return { from, to };
}

/** Rendered line index containing a character offset in the joined text. */
function lineIndexAtOffset(lines: RenderedLine[], offset: number): number {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].text.length) return i;
    remaining -= lines[i].text.length + 1;
  }
  return lines.length - 1;
}

/**
 * How much does a rendered line look like the raw file line a search match
 * came from? 1 for equality; containment scores by the contained share so
 * a trivially short line can't outrank the real one; otherwise the share
 * of the raw line's words present in the rendered line. Robust to disk
 * bytes the serializer would normalize (wrapping, punctuation, syntax).
 */
function lineSimilarity(rawLine: string, renderedLine: string): number {
  const raw = rawLine.trim();
  const r = renderedLine.trim();
  if (!raw || !r) return 0;
  if (raw === r) return 1;

  let score = 0;
  if (raw.includes(r)) score = r.length / raw.length;
  if (r.includes(raw)) score = Math.max(score, raw.length / r.length);

  const words = raw.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (words.length > 0) {
    const hits = words.filter((w) => r.includes(w)).length;
    score = Math.max(score, hits / words.length);
  }
  return score;
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
 * Keep the candidate offsets whose rendered line best resembles the raw
 * line the match came from. Works even when the disk file's bytes differ
 * from the serialization (frontmatter, wrapped paragraphs, punctuation
 * normalization). Keeps everything when nothing scores.
 */
function narrowByLineText(
  lines: RenderedLine[],
  candidates: number[],
  lineText: string,
): number[] {
  const scored = candidates.map((o) => ({
    o,
    s: lineSimilarity(lineText, lines[lineIndexAtOffset(lines, o)].text),
  }));
  const best = Math.max(...scored.map((x) => x.s));
  if (best === 0) return candidates;
  return scored.filter((x) => x.s === best).map((x) => x.o);
}

/**
 * Which occurrence of `expectedText` do the raw coordinates point at?
 * Only answers when the raw offset verifiably holds the text (i.e. the
 * serialized markdown matches the coordinates' source bytes).
 */
function occurrenceIndexInRaw(
  rawMarkdown: string,
  line: number,
  column: number,
  expectedText: string,
): number | undefined {
  const rawOffset = rawLineColumnToOffset(rawMarkdown.split("\n"), line, column);
  if (!rawMarkdown.startsWith(expectedText, rawOffset)) return undefined;
  let n = 0;
  let j = rawMarkdown.indexOf(expectedText);
  while (j !== -1 && j < rawOffset) {
    n++;
    j = rawMarkdown.indexOf(expectedText, j + 1);
  }
  return n;
}

function resolveByExpectedText(
  lines: RenderedLine[],
  rendered: string,
  location: EditorLocation,
  rawMarkdown?: string,
): { from: number; to: number } | null {
  const expectedText = location.expectedText as string;
  const line = location.line;
  const column = location.column ?? 1;

  const occurrences = allOffsetsOf(rendered, expectedText);
  if (occurrences.length === 0) return null;

  // Tier 1 — lineText similarity narrowing.
  let candidates = occurrences;
  if (location.lineText !== undefined && candidates.length > 1) {
    candidates = narrowByLineText(lines, candidates, location.lineText);
  }

  const chosen =
    candidates.length === 1
      ? candidates[0]
      : chooseByOccurrenceArithmetic(
          occurrences,
          candidates,
          location,
          rawMarkdown,
        ) ??
        chooseNearestToHint(lines, candidates, line, column, rawMarkdown);

  return {
    from: posAtRenderedOffset(lines, chosen),
    to: posAtRenderedOffset(lines, chosen + expectedText.length - 1) + 1,
  };
}

/**
 * Tier 2 — occurrence arithmetic. The panel's occurrence index applies
 * when no narrowing happened (indices still line up); the serialized
 * markdown's own count applies when the file is canonical.
 */
function chooseByOccurrenceArithmetic(
  occurrences: number[],
  candidates: number[],
  location: EditorLocation,
  rawMarkdown?: string,
): number | undefined {
  if (candidates.length === occurrences.length) {
    const n = location.occurrence;
    if (n !== undefined && n >= 0 && n < occurrences.length) {
      return occurrences[n];
    }
  }
  if (rawMarkdown !== undefined) {
    const n = occurrenceIndexInRaw(
      rawMarkdown,
      location.line,
      location.column ?? 1,
      location.expectedText as string,
    );
    if (n !== undefined && candidates.includes(occurrences[n])) {
      return occurrences[n];
    }
  }
  return undefined;
}

/** Tier 3 — nearest candidate to the aligned line hint. */
function chooseNearestToHint(
  lines: RenderedLine[],
  candidates: number[],
  line: number,
  column: number,
  rawMarkdown?: string,
): number {
  const hint = mapRawLineColumn(lines, line, column, rawMarkdown);
  const hintOffset = renderedLineStartOffset(lines, hint.li) + hint.offset;
  return candidates.reduce((best, o) =>
    Math.abs(o - hintOffset) < Math.abs(best - hintOffset) ? o : best,
  );
}
