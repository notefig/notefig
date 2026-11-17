/**
 * The markdown three-way merge (MET-271): pure, and it never leaves
 * conflict markers. Run off the main thread, in the markdown worker
 * (`mergeMarkdownOffThread`).
 *
 * It works on source text, so bytes neither side touched stay as they
 * were. A file is cut at line starts into units: a heading or paragraph, a
 * list item (a sub-item is its own), a table row, a code, HTML or
 * frontmatter block, a rule. diff3 aligns the three versions' units; where
 * both sides changed the same stretch of them:
 *
 * - changes to different units, even next to each other, are both taken;
 * - inserts at the same spot are both kept, the holder's first;
 * - a delete against an edit keeps the edit;
 * - one unit edited on both sides is merged by words when the edits don't
 *   touch; otherwise the holder's text stands, and the other side's comes
 *   back in `overwritten`, to flag it.
 *
 * The holder is `theirs`: the side already on the branch.
 */
import diff3Merge from "diff3";
import { splitUnits, type Unit } from "@/utils/markdown-units";

export interface MergedMarkdown {
  text: string;
  /** The text of each of our units the holder's replaced. */
  overwritten: string[];
}

/** A side's change to a stretch of the base: `base[start, end)` became
 *  `units`. */
interface Change {
  start: number;
  end: number;
  units: string[];
}

/** Join text when units collide wholesale, for the flag. */
const BLANK = "\n\n";

const words = (text: string) => text.match(/\s+|\S+/g) ?? [];

/** One unit's three versions merged by words; null when the edits touch. */
function mergeWords(ours: string, base: string, theirs: string): string | null {
  const merged: string[] = [];
  for (const region of diff3Merge(words(ours), words(base), words(theirs))) {
    if (region.conflict) return null;
    merged.push(...region.ok);
  }
  return merged.join("");
}

function mergeUnit(ours: string, base: string, theirs: string, overwritten: string[]): string {
  if (ours === base || ours === theirs) return theirs;
  if (theirs === base) return ours;
  const merged = mergeWords(ours, base, theirs);
  if (merged !== null) return merged;
  overwritten.push(ours);
  return theirs;
}

/** What `side` changed of `base`: the stretch between their common start
 *  and common end. */
function changeOf(side: string[], base: string[]): Change {
  let start = 0;
  while (start < side.length && start < base.length && side[start] === base[start]) start++;
  let tail = 0;
  while (tail < side.length - start && tail < base.length - start && side[side.length - 1 - tail] === base[base.length - 1 - tail]) tail++;
  return { start, end: base.length - tail, units: side.slice(start, side.length - tail) };
}

/** Both changes on the base, in order; the holder's first at one spot. */
function applyBoth(base: string[], ours: Change, theirs: Change): string[] {
  const theirsFirst = theirs.start < ours.start || (theirs.start === ours.start && theirs.end <= ours.end);
  const [first, second] = theirsFirst ? [theirs, ours] : [ours, theirs];
  return [
    ...base.slice(0, first.start),
    ...first.units,
    ...base.slice(first.end, second.start),
    ...second.units,
    ...base.slice(second.end),
  ];
}

/** A stretch both sides changed (diff3's conflict): the units to keep. */
function resolve(ours: string[], base: string[], theirs: string[], overwritten: string[]): string[] {
  if (base.length === 0) return [...theirs, ...ours];
  if (ours.length === 0) return theirs;
  if (theirs.length === 0) return ours;
  const mine = changeOf(ours, base);
  const held = changeOf(theirs, base);
  if (mine.end <= held.start || held.end <= mine.start) return applyBoth(base, mine, held);
  if (ours.length === base.length && theirs.length === base.length) {
    return base.map((unit, i) => mergeUnit(ours[i]!, unit, theirs[i]!, overwritten));
  }
  if (mine.units.length > 0) overwritten.push(mine.units.join(BLANK));
  return theirs;
}

const pairKey = (unit: string, next: string) => `${unit}\u0000${next}`;

/** What a unit is, as far as the line break after it goes: a table row
 *  or a list item runs on to the next of its kind on the next line. */
function kindOf(unit: string): "row" | "item" | "block" {
  const line = unit.trimStart();
  if (line.startsWith("|")) return "row";
  return /^([-*+]|\d+[.)])(\s|$)/.test(line) ? "item" : "block";
}

/** The whitespace between neighbouring units, as the sides have it; read
 *  from the one that yields to the one that holds, so the holder's wins. */
function gapsOf(sides: Unit[][]) {
  const pairs = new Map<string, string>();
  const after = new Map<string, string>();
  for (const units of sides) {
    for (let i = 0; i + 1 < units.length; i++) {
      pairs.set(pairKey(units[i]!.text, units[i + 1]!.text), units[i]!.gap);
      after.set(units[i]!.text, units[i]!.gap);
    }
  }
  /** Between `unit` and `next`: as a side had them; else, for two rows or
   *  two items (edited side by side), the line break `unit` had before one
   *  of its kind; else a blank line, which never runs one unit into the
   *  next (a paragraph into the list item above it). */
  return (unit: string, next: string, eol: string): string => {
    const known = pairs.get(pairKey(unit, next));
    if (known !== undefined) return known;
    const kind = kindOf(unit);
    if (kind === "block" || kind !== kindOf(next)) return eol + eol;
    return after.get(unit) ?? eol;
  };
}

/** Merge three versions of a markdown file; `theirs` holds. */
export async function mergeMarkdown(base: string, ours: string, theirs: string): Promise<MergedMarkdown> {
  if (ours === base || ours === theirs) return { text: theirs, overwritten: [] };
  if (theirs === base) return { text: ours, overwritten: [] };
  const [o, a, b] = await Promise.all([base, ours, theirs].map(splitUnits));
  const texts = (units: Unit[]) => units.map((unit) => unit.text);
  const overwritten: string[] = [];
  const merged = diff3Merge(texts(a!), texts(o!), texts(b!)).flatMap((region) =>
    region.conflict ? resolve(region.conflict.a, region.conflict.o, region.conflict.b, overwritten) : region.ok,
  );
  const eol = /\r\n/.test(theirs || ours) ? "\r\n" : "\n";
  const gapBetween = gapsOf([o!, a!, b!]);
  const end = (b!.length > 0 ? b! : a!).at(-1)?.gap ?? eol;
  const text = merged
    .map((unit, i) => unit + (i === merged.length - 1 ? end : gapBetween(unit, merged[i + 1]!, eol)))
    .join("");
  return { text, overwritten };
}
