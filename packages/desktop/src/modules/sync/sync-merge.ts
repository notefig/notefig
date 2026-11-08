/**
 * The markdown 3-way merge (MET-271): pure, never conflict markers.
 *
 * It works on source text, so what neither side touched keeps its bytes.
 * A file is cut into units at line starts: headings and paragraphs, list
 * items (a sub-item is its own unit), table rows, code blocks, frontmatter.
 * One diff3 aligns the units. Where both sides changed the same units, the
 * words inside are merged only when one unit faces one unit; anything that
 * still collides goes to the holder, and the loser's text comes back in
 * `overwritten`, to flag it.
 *
 * The holder is the side already on the branch (`theirs`). A delete against
 * an edit keeps the edit.
 */
import diff3Merge from "diff3";
import MarkdownIt from "markdown-it";

export interface MergedMarkdown {
  text: string;
  /** The loser's text of each unit the holder took. */
  overwritten: string[];
}

interface Unit {
  /** What units are compared by: the text without its trailing blank lines. */
  text: string;
  /** The newlines after it. */
  gap: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;
/** The tokens a unit starts at. Containers (a list, a quote, a table) have
 *  none of their own: their items, rows and paragraphs do. */
const UNIT_STARTS = new Set([
  "heading_open",
  "paragraph_open",
  "list_item_open",
  "tr_open",
  "fence",
  "code_block",
  "html_block",
  "hr",
]);
const parser = new MarkdownIt({ html: true });

function toUnit(chunk: string): Unit {
  const text = chunk.replace(/\s+$/, "");
  return { text, gap: chunk.slice(text.length) };
}

/** The units of `source`; their chunks concatenate back to it. */
export function splitUnits(source: string): Unit[] {
  const frontmatter = FRONTMATTER.exec(source)?.[0] ?? "";
  const body = source.slice(frontmatter.length);
  const lineStarts = [0];
  for (let at = body.indexOf("\n"); at >= 0; at = body.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  const cuts = parser
    .parse(body, {})
    .filter((token) => UNIT_STARTS.has(token.type) && token.map)
    .map((token) => lineStarts[token.map![0]]);
  // Whatever precedes the first unit rides with it.
  const starts = [...new Set(cuts)].sort((a, b) => a - b).slice(1);
  const chunks = [0, ...starts].map((at, i) => body.slice(at, starts[i] ?? body.length)).filter(Boolean);
  return [...(frontmatter ? [frontmatter] : []), ...chunks].map(toUnit);
}

const words = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];

/** One unit's three versions merged by words; null when they collide. */
function mergeWords(ours: string, base: string, theirs: string): string | null {
  const merged: string[] = [];
  for (const region of diff3Merge(words(ours), words(base), words(theirs))) {
    if (region.conflict) return null;
    merged.push(...region.ok);
  }
  return merged.join("");
}

/** Units both sides changed: the texts to keep, and what the holder beat. */
function resolve(ours: string[], base: string[], theirs: string[], overwritten: string[]): string[] {
  if (ours.length === 0) return theirs;
  if (theirs.length === 0) return ours;
  if (ours.length !== theirs.length) {
    overwritten.push(ours.join("\n\n"));
    return theirs;
  }
  return ours.map((text, i) => {
    const merged = mergeWords(text, base[i] ?? "", theirs[i]);
    if (merged !== null) return merged;
    overwritten.push(text);
    return theirs[i];
  });
}

/** Each text's widest gap, so a unit that was last keeps its blank line
 *  when something now follows it. */
function gapsOf(sides: Unit[][]): Map<string, string> {
  const gaps = new Map<string, string>();
  for (const unit of sides.flat()) {
    if (unit.gap.length > (gaps.get(unit.text)?.length ?? -1)) gaps.set(unit.text, unit.gap);
  }
  return gaps;
}

export function mergeMarkdown(base: string, ours: string, theirs: string): MergedMarkdown {
  const [o, a, b] = [base, ours, theirs].map(splitUnits);
  const texts = (units: Unit[]) => units.map((unit) => unit.text);
  const overwritten: string[] = [];
  const merged = diff3Merge(texts(a), texts(o), texts(b)).flatMap((region) =>
    region.conflict ? resolve(region.conflict.a, region.conflict.o, region.conflict.b, overwritten) : region.ok,
  );
  const gaps = gapsOf([o, a, b]);
  const end = b[b.length - 1]?.gap ?? "\n";
  const text = merged.map((unit, i) => unit + (i === merged.length - 1 ? end : (gaps.get(unit) ?? "\n\n"))).join("");
  return { text, overwritten };
}
