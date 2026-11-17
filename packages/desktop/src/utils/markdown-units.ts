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

/** The file as last known: its bytes, and what the serializer makes of
 *  them (null until first needed). */
export interface SavedSource {
  source: string;
  canonical: string | null;
}

/**
 * `canonical`, with `source`'s own bytes for each unit the save didn't
 * change. `previous` is what the serializer made of `source`; a unit of
 * `canonical` equal to its counterpart there, counted from either end
 * (the stretch a save changed lies between), is written as `source` had
 * it, and so is the whitespace between two such units and the file's end.
 * Units are paired by position, so this can't tell when the serializer
 * merged or split units; the caller checks the result parses the same.
 *
 * `widen` rewrites the whole list or table around the change (the units
 * the source runs together with no blank line): a new item in the
 * serializer's markers among the source's would start a list of its own.
 */
export async function keepUntouched(source: string, previous: string, canonical: string, widen = false): Promise<string> {
  const [kept, before, after] = await Promise.all([source, previous, canonical].map(splitUnits));
  const s = kept!, p = before!, n = after!;
  const max = Math.min(s.length, p.length, n.length);
  let head = 0;
  while (head < max && p[head]!.text === n[head]!.text) head++;
  let tail = 0;
  while (tail < max - head && p[p.length - 1 - tail]!.text === n[n.length - 1 - tail]!.text) tail++;
  const blank = (gap: string) => /\n[ \t]*\r?\n/.test(gap);
  const runsOn = (gap: string | undefined) => gap !== undefined && !blank(gap);
  while (widen && head > 0 && runsOn(s[head - 1]!.gap)) head--;
  while (widen && tail > 0 && runsOn(s[s.length - tail - 1]?.gap)) tail--;
  const crlf = source.includes("\r\n");
  const fresh = (text: string) => (crlf ? text.replace(/\r?\n/g, "\r\n") : text);
  const sourceOf = (i: number) => (i < head ? i : i >= n.length - tail ? s.length - (n.length - i) : null);
  const out = n.map((unit, i) => {
    const at = sourceOf(i);
    const last = i === n.length - 1;
    const text = at === null ? fresh(unit.text) : s[at]!.text;
    if (last) return text + (s.at(-1)?.gap ?? fresh(unit.gap));
    const next = sourceOf(i + 1);
    if (at !== null && next === at + 1) return text + s[at]!.gap;
    // At the edge of the changed stretch, the source's spacing on that
    // side, as long as both separate blocks there (no list run-on).
    const edge = at !== null ? s[at]!.gap : next !== null ? s[next - 1]?.gap : undefined;
    return text + (edge !== undefined && blank(edge) && blank(unit.gap) ? edge : fresh(unit.gap));
  });
  return out.join("");
}

/**
 * The save: `doc` serialized, keeping the bytes of what didn't change since
 * `previous` (MET-292), so a one-word edit rewrites one unit, not the file's
 * list markers, indents and final newline. Whatever is written parses to
 * the same document as the plain serialization (compared as the HTML the
 * doc is parsed from); when keeping bytes would change that, the plain one
 * is written.
 */
export async function serializeKeeping(
  codec: Pick<MarkdownCodec, "parse" | "serialize" | "hash" | "render">,
  doc: JSONContent,
  previous: SavedSource | null,
): Promise<{ markdown: string; canonical: string; hash: string }> {
  const canonical = codec.serialize(doc);
  let markdown = canonical;
  if (previous && previous.source !== canonical) {
    const before = previous.canonical ?? codec.serialize(codec.parse(previous.source));
    const body = previous.source.trimEnd();
    markdown =
      body === before.trimEnd()
        ? // Already in the serializer's style (as Notefig writes it): only
          // the file's ending to keep, which never changes what it parses to.
          canonical.trimEnd() + previous.source.slice(body.length)
        : await keptIfSame(codec, previous.source, before, canonical);
  }
  return { markdown, canonical, hash: codec.hash(markdown) };
}

/** `keepUntouched`'s result when it renders to the same HTML as
 *  `canonical` (so parses to the same doc, checked without the DOM),
 *  narrow first, then widened; else `canonical`. */
async function keptIfSame(codec: Pick<MarkdownCodec, "render">, source: string, before: string, canonical: string): Promise<string> {
  const target = codec.render(canonical);
  for (const widen of [false, true]) {
    const kept = await keepUntouched(source, before, canonical, widen);
    if (kept === canonical) return canonical;
    if (codec.render(kept) === target) return kept;
  }
  return canonical;
}
