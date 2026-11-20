/**
 * A document's units as the editor holds them (MET-272, MET-273): each
 * textblock with text; a table row or code block whole; a block atom. A
 * prompt widget is its marker alone, and only once it's bound to a task
 * (its draft, and an unbound widget, never reach the file). Empty
 * paragraphs aren't in the markdown, so aren't units.
 *
 * They're the merge's units (`utils/markdown-units.ts`) seen from the
 * ProseMirror side: a caret (`SyncCursor`) points at one by its place, a
 * claim (`SyncClaim`) names one by its key, a hash of what it says, so
 * every device finds the same unit whatever the text above it holds.
 * Pure: the editor calls it on its doc, the markdown worker on a parse.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { PROMPT_NODE_NAME, serializePromptMarker } from "@notefig/widgets";

export interface DocUnit {
  from: number;
  to: number;
}

/** A unit and what names it; `key` is null for an empty textblock, a
 *  unit only once it's typed in. */
export interface KeyedUnit extends DocUnit {
  key: string | null;
}

const isWhole = (node: PMNode) => node.type.name === "tableRow" || node.type.spec.code === true;

/** What `node` is to the walk: a unit, a container to go into, or neither. */
function kindOf(node: PMNode): "unit" | "empty" | "into" | "skip" {
  if (node.type.name === PROMPT_NODE_NAME) return serializePromptMarker(node.attrs) ? "unit" : "skip";
  if (isWhole(node) || (node.isAtom && node.isBlock)) return "unit";
  if (!node.isTextblock) return "into";
  return node.content.size > 0 ? "unit" : "empty";
}

/** Each unit of `doc` in order, with its node. */
function eachUnit(doc: PMNode, visit: (node: PMNode, unit: DocUnit) => void) {
  doc.descendants((node, pos) => {
    const kind = kindOf(node);
    if (kind === "unit") visit(node, { from: pos, to: pos + node.nodeSize });
    return kind === "into";
  });
}

/** The document's units in order, as the file has them. */
export function docUnits(doc: PMNode): DocUnit[] {
  const units: DocUnit[] = [];
  eachUnit(doc, (_, unit) => units.push(unit));
  return units;
}

/** FNV-1a, base 36: short, and the same on every device. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** A node's hashes, kept with it: a doc shares every node an edit didn't
 *  touch with the doc before it, so a keystroke hashes one unit. */
const textHashes = new WeakMap<PMNode, string>();
const contentHashes = new WeakMap<PMNode, string>();

/** What names a unit: its kind and its text. Marks don't count, so making
 *  a word bold keeps the key. */
function textHash(node: PMNode): string {
  let known = textHashes.get(node);
  if (known === undefined) {
    if (node.type.name === PROMPT_NODE_NAME) known = hash(`prompt\u0000${serializePromptMarker(node.attrs)}`);
    else if (node.isAtom) known = hash(`${node.type.name}\u0000${JSON.stringify(node.attrs)}`);
    else known = hash(`${node.type.name}\u0000${node.textContent}`);
    textHashes.set(node, known);
  }
  return known;
}

/** Everything a unit says, marks and links included: what tells whether a
 *  write changed it. */
function contentHash(node: PMNode): string {
  let known = contentHashes.get(node);
  if (known === undefined) contentHashes.set(node, (known = hash(JSON.stringify(node.toJSON()))));
  return known;
}

/** A unit as a whole file sees it: its key, and its whole content. */
export interface FileUnit {
  key: string;
  content: string;
}

/** Finds, in one copy of a file, the unit another device's key names. */
export interface UnitIndex {
  /** The key of the unit `key` names here; null when there's none. */
  resolve(key: string): string | null;
}

interface Keyed {
  units: (DocUnit & FileUnit)[];
  byFrom: Map<number, string>;
  index: UnitIndex;
}

const partsOf = (key: string) => {
  const [text = "", before = "", after = "", nth = "0"] = key.split(".");
  return { text, before, after, nth: Number(nth) };
};

/** How much of two keys' context agrees, for two units saying the same:
 *  the text before, the text after, and which repeat each is. A neighbour
 *  that says what the unit says (a run of one item) tells nothing apart, so
 *  it doesn't count. */
function agreement(a: string, b: string): number {
  const [x, y] = [partsOf(a), partsOf(b)];
  if (x.text !== y.text) return -1;
  let score = x.nth === y.nth ? 1 : 0;
  if (x.before === y.before && x.before !== x.text) score++;
  if (x.after === y.after && x.after !== x.text) score++;
  return score;
}

/** Two keys for one unit, from copies that may differ around it: the same
 *  text, and two of its three marks of place (the text before, the text
 *  after, which repeat). An edit beside it, or a copy of its text added
 *  further up, changes one; separate repeats of one text, even a run of
 *  them, differ in two. */
export function sameUnit(a: string, b: string): boolean {
  return a === b || agreement(a, b) >= 2;
}

/** An index over a file's keys, to find the one unit another copy's key
 *  names. Text said once is that unit, wherever it sits and whatever is
 *  next to it. Repeated text is the copy whose place agrees most, the
 *  repeat breaking a tie: one unit, never every copy. */
export function unitIndex(keys: string[]): UnitIndex {
  const byText = new Map<string, string[]>();
  for (const key of keys) {
    const { text } = partsOf(key);
    const same = byText.get(text);
    if (same) same.push(key);
    else byText.set(text, [key]);
  }
  return {
    resolve(key) {
      const same = byText.get(partsOf(key).text) ?? [];
      if (same.length <= 1) return same[0] ?? null;
      let best = same[0]!;
      for (const candidate of same) if (agreement(key, candidate) > agreement(key, best)) best = candidate;
      return best;
    },
  };
}
const keyedDocs = new WeakMap<PMNode, Keyed>();

/** Every unit of `doc`, keyed `<text>.<text before>.<text after>.<repeat>`
 *  (see `unitIndex`); the first unit's before and the last's after are `0`. */
function keyed(doc: PMNode): Keyed {
  let known = keyedDocs.get(doc);
  if (known) return known;
  const found: (DocUnit & { text: string; content: string })[] = [];
  eachUnit(doc, (node, unit) => found.push({ ...unit, text: textHash(node), content: contentHash(node) }));
  const seen = new Map<string, number>();
  const units = found.map(({ text, content, ...unit }, i) => {
    const nth = seen.get(text) ?? 0;
    seen.set(text, nth + 1);
    const key = `${text}.${found[i - 1]?.text ?? "0"}.${found[i + 1]?.text ?? "0"}.${nth}`;
    return { ...unit, key, content };
  });
  const keys = units.map((unit) => unit.key);
  known = { units, byFrom: new Map(units.map((unit) => [unit.from, unit.key])), index: unitIndex(keys) };
  keyedDocs.set(doc, known);
  return known;
}

/** The index of `doc`'s units, for finding what others' keys name. */
export const indexOf = (doc: PMNode): UnitIndex => keyed(doc).index;

/** Every unit of `doc`, keyed. */
export const keyedUnits = (doc: PMNode): (DocUnit & FileUnit)[] => keyed(doc).units;

/** A file's units in order, as claims see them. */
export const fileUnitsOf = (doc: PMNode): FileUnit[] => keyed(doc).units.map(({ key, content }) => ({ key, content }));

/** The units `[from, to)` touches, empty textblocks included: what an edit
 *  there changes. Prompt widgets are left out: their drafts are this
 *  device's alone. An empty range is the unit around it. */
export function unitsIn(doc: PMNode, from: number, to: number): KeyedUnit[] {
  const units: KeyedUnit[] = [];
  const visit = (node: PMNode, pos: number) => {
    const kind = node.type.name === PROMPT_NODE_NAME ? "skip" : kindOf(node);
    if (kind === "into") return true;
    if (kind === "unit") units.push({ from: pos, to: pos + node.nodeSize, key: keyed(doc).byFrom.get(pos) ?? null });
    if (kind === "empty") units.push({ from: pos, to: pos + node.nodeSize, key: null });
    return false;
  };
  if (from < to) {
    doc.nodesBetween(from, to, visit);
    return units;
  }
  // Inside a unit: the shallowest ancestor that is one.
  const $pos = doc.resolve(Math.min(from, doc.content.size));
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (visit(node, $pos.before(depth)) !== true) return units;
  }
  return units;
}

/** Where the selection's head is, as a unit and a character in it. */
export function cursorAt(doc: PMNode, head: number): { unit: number; offset: number } {
  const units = docUnits(doc);
  const found = units.findIndex(({ to }) => head <= to);
  const unit = found < 0 ? Math.max(units.length - 1, 0) : found;
  return { unit, offset: Math.max(0, head - (units[unit]?.from ?? 0) - 1) };
}
