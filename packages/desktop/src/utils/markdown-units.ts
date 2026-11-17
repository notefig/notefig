/**
 * Markdown cut into units, the one splitter both sync's merge
 * (`modules/sync/sync-merge.ts`) and the editor's save use (MET-292): a
 * heading or paragraph, a list item (a sub-item is its own), a table row, a
 * code, HTML or frontmatter block, a rule. Cut at line starts, so text and
 * gaps, joined, give the source back byte for byte.
 */
import type MarkdownIt from "markdown-it";
import type { JSONContent } from "@tiptap/core";
import type { MarkdownCodec } from "@/components/editor/markdown-codec";

export interface Unit {
  /** What units are compared by: the chunk without its trailing blank. */
  text: string;
  /** The whitespace after it, up to the next unit. */
  gap: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;
/** The tokens a unit starts at. Containers (a list, a quote, a table) have
 *  none of their own: their items, rows and paragraphs do. */
const UNIT_STARTS = new Set(["heading_open", "paragraph_open", "list_item_open", "tr_open", "fence", "code_block", "html_block", "hr"]);

let parser: MarkdownIt | null = null;
/** Built on first use: the worker boots without it. */
async function parserOf(): Promise<MarkdownIt> {
  if (!parser) {
    const { default: Markdown } = await import("markdown-it");
    parser = new Markdown({ html: true });
  }
  return parser;
}

function toUnit(chunk: string): Unit {
  const text = chunk.replace(/\s+$/, "");
  return { text, gap: chunk.slice(text.length) };
}

/** The units of `source`; text and gap, concatenated, give it back. */
export async function splitUnits(source: string): Promise<Unit[]> {
  const md = await parserOf();
  const frontmatter = FRONTMATTER.exec(source)?.[0] ?? "";
  const body = source.slice(frontmatter.length);
  const lineStarts = [0];
  for (let at = body.indexOf("\n"); at >= 0; at = body.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  const cuts = md
    .parse(body, {})
    .filter((token) => UNIT_STARTS.has(token.type) && token.map)
    .map((token) => lineStarts[token.map![0]]!);
  // Whatever comes before the first unit (blank lines) rides with it.
  const starts = [...new Set(cuts)].sort((a, b) => a - b).filter((at) => at > 0);
  const chunks = [0, ...starts].map((at, i) => body.slice(at, starts[i] ?? body.length)).filter(Boolean);
  return [...(frontmatter ? [frontmatter] : []), ...chunks].map(toUnit);
}

/** A stretch of the file as it's written (`source`) and as the serializer
 *  writes the same content (`canonical`). */
export interface Segment {
  source: string;
  canonical: string;
}

/** The file as the editor last knew it, for the next save to keep its bytes:
 *  cut into segments by the last save, or as loaded or adopted (with the
 *  doc it was parsed into, when at hand). Callers hand back what the last
 *  save returned. */
export type SavedFile = { segments: Segment[] } | { source: string; doc: JSONContent | null };

export interface KeptSave {
  markdown: string;
  hash: string;
  saved: SavedFile;
}

type Codec = Pick<MarkdownCodec, "parse" | "serialize" | "hash" | "render">;

const joinSource = (segments: Segment[]) => segments.map((segment) => segment.source).join("");
const joinCanonical = (segments: Segment[]) => segments.map((segment) => segment.canonical).join("");
const endingOf = (text: string) => text.slice(text.trimEnd().length);
const wordsOf = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "");
const BLANK_END = /\n[ \t]*\r?\n[ \t]*$/;
/** A list item, an indented line or a quote: after a blank line, still part
 *  of the list or quote above when that's one too. */
const IN_LIST = /^(?:\r?\n)*([ \t]+\S|[-*+](\s|$)|\d+[.)](\s|$)|>)/;
/** A link reference or footnote definition: read wherever it stands. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * The save: `doc` serialized, keeping the bytes of what didn't change since
 * `previous` (MET-292), so a one-word edit rewrites one unit, not the file's
 * list markers, indents and final newline.
 *
 * The file is carried from save to save as segments, so a save diffs the new
 * serialization against the last one by characters and swaps the segments
 * the change touched for the new text. Whatever is written parses to the
 * same document as the plain serialization: the blocks around the change
 * (the whole file, when a definition could reach into them) must render to
 * the same HTML as their serialization, or they're written plain.
 */
export async function serializeKeeping(codec: Codec, doc: JSONContent, previous: SavedFile | null): Promise<KeptSave> {
  const canonical = codec.serialize(doc);
  if (!previous) return saved(codec, [{ source: canonical, canonical }]);
  const { segments } = await prepareSaved(codec, previous);
  // An emptied file has nothing to keep.
  if (segments.length === 0) return saved(codec, [{ source: canonical, canonical }]);
  const source = joinSource(segments);
  const crlf = source.includes("\r\n");
  const before = joinCanonical(segments);
  if (before === canonical) return saved(codec, segments);
  const { at, next } = replace(segments, before, canonical, crlf);
  // A definition the change removed still reached the blocks it kept.
  const [start, end] = DEFINITION.test(source) ? [0, next.length] : around(next, at);
  const window = next.slice(start, end);
  if (sameHtml(codec, window, end === next.length)) return saved(codec, next);
  return saved(codec, [...next.slice(0, start), plain(joinCanonical(window), endingOf(joinSource(window)), crlf), ...next.slice(end)]);
}

function saved(codec: Codec, segments: Segment[]): KeptSave {
  const markdown = joinSource(segments);
  return { markdown, hash: codec.hash(markdown), saved: { segments } };
}

/** The serializer's text as a segment, ending as `ending` says (the file's
 *  final newline, or the spacing before the next block). */
function plain(canonical: string, ending: string, crlf: boolean): Segment {
  const source = canonical.trimEnd() + ending;
  return { source: crlf ? source.replace(/\r?\n/g, "\r\n") : source, canonical };
}

/** `saved` cut into segments, as the next save needs it: the work a first
 *  save would do, done ahead (`DocumentSync.prepare`). */
export async function prepareSaved(codec: Pick<Codec, "parse" | "serialize">, saved: SavedFile): Promise<{ segments: Segment[] }> {
  return "segments" in saved ? saved : { segments: await cut(codec, saved.source, saved.doc) };
}

/**
 * `source` paired unit for unit with what the serializer makes of it. A pair
 * whose words differ (misaligned, or text the serializer rewrites, like an
 * entity) joins the segment before it; a file already in the serializer's
 * style, or that doesn't cut into as many units, is one segment.
 */
async function cut(codec: Pick<Codec, "parse" | "serialize">, source: string, doc: JSONContent | null): Promise<Segment[]> {
  const canonical = codec.serialize(doc ?? codec.parse(source));
  if (source.trimEnd() === canonical.trimEnd()) return [{ source, canonical }];
  const [ours, theirs] = await Promise.all([splitUnits(source), splitUnits(canonical)]);
  if (ours.length !== theirs.length) return [{ source, canonical }];
  const segments: Segment[] = [];
  ours.forEach((unit, i) => {
    const pair = { source: unit.text + unit.gap, canonical: theirs[i]!.text + theirs[i]!.gap };
    const last = segments.at(-1);
    if (!last || wordsOf(unit.text) === wordsOf(theirs[i]!.text)) segments.push(pair);
    else segments[segments.length - 1] = { source: last.source + pair.source, canonical: last.canonical + pair.canonical };
  });
  return segments;
}

/**
 * `segments` with those the change from `before` to `canonical` touched
 * (past their common start, short of their common end) swapped for one
 * segment of the new text, at `at`. A change at the file's end takes the
 * last segment, keeping the file's ending.
 */
function replace(segments: Segment[], before: string, canonical: string, crlf: boolean) {
  const [head, removedEnd] = changed(before, canonical);
  const ends: number[] = [];
  for (const segment of segments) ends.push((ends.at(-1) ?? 0) + segment.canonical.length);
  const startOf = (i: number) => (i === 0 ? 0 : ends[i - 1]!);
  const last = segments.length - 1;
  // Appending at the very end belongs to the last segment.
  const touched = ends.findIndex((end) => end > head);
  const from = touched < 0 ? last : touched;
  let to = from;
  // An insertion right at a segment's start is a segment of its own.
  if (removedEnd > head || startOf(from) < head) while (to <= last && (to === from || startOf(to) < removedEnd)) to++;
  const text = canonical.slice(startOf(from), (to > from ? ends[to - 1]! : startOf(from)) + canonical.length - before.length);
  const ending = to > last ? endingOf(segments[last]!.source) : endingOf(text);
  const fresh = text ? [plain(text, ending, crlf)] : [];
  return { at: from, next: [...segments.slice(0, from), ...fresh, ...segments.slice(to)] };
}

/** Where `after` stops matching `before` from the start, and where in
 *  `before` it matches again to the end. */
function changed(before: string, after: string): [number, number] {
  const shorter = Math.min(before.length, after.length);
  let head = 0;
  while (head < shorter && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < shorter - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return [head, before.length - tail];
}

/** The blocks around segment `at` that render on their own: out to a blank
 *  line between two blocks that aren't both in a list or quote. */
function around(segments: Segment[], at: number): [number, number] {
  const apart = (above: string, below: string) => BLANK_END.test(above) && !(IN_LIST.test(above) && IN_LIST.test(below));
  const boundary = (k: number) =>
    k <= 0 ||
    k >= segments.length ||
    (apart(segments[k - 1]!.source, segments[k]!.source) && apart(segments[k - 1]!.canonical, segments[k]!.canonical));
  let start = Math.min(at, segments.length - 1);
  while (!boundary(start)) start--;
  let end = Math.min(at + 1, segments.length);
  while (!boundary(end)) end++;
  return [Math.max(0, start), end];
}

/** Whether the segments' sources render as their serialization does: without
 *  rendering when they're the same text (the file's ending aside). */
function sameHtml(codec: Codec, segments: Segment[], toEnd: boolean): boolean {
  const same = (segment: Segment, i: number) =>
    segment.source === segment.canonical || (toEnd && i === segments.length - 1 && segment.source.trimEnd() === segment.canonical.trimEnd());
  return segments.every(same) || codec.render(joinSource(segments)) === codec.render(joinCanonical(segments));
}
