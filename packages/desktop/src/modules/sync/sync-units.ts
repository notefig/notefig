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

/** What names a unit: its kind and its text. Marks don't count, so making
 *  a word bold keeps the key. */
export function unitKey(node: PMNode): string {
  if (node.type.name === PROMPT_NODE_NAME) return hash(`prompt\u0000${serializePromptMarker(node.attrs)}`);
  if (node.isAtom) return hash(`${node.type.name}\u0000${JSON.stringify(node.attrs)}`);
  return hash(`${node.type.name}\u0000${node.textContent}`);
}

/** Every unit of `doc`, keyed. */
export function keyedUnits(doc: PMNode): (DocUnit & { key: string })[] {
  const units: (DocUnit & { key: string })[] = [];
  eachUnit(doc, (node, unit) => units.push({ ...unit, key: unitKey(node) }));
  return units;
}

/** The keys of `doc`'s units, in order: a file as claims see it. */
export const unitKeysOf = (doc: PMNode): string[] => keyedUnits(doc).map((unit) => unit.key);

/** The units `[from, to)` touches, empty textblocks included: what an edit
 *  there changes. Prompt widgets are left out: their drafts are this
 *  device's alone. An empty range is the unit around it. */
export function unitsIn(doc: PMNode, from: number, to: number): KeyedUnit[] {
  const units: KeyedUnit[] = [];
  const visit = (node: PMNode, pos: number) => {
    const kind = node.type.name === PROMPT_NODE_NAME ? "skip" : kindOf(node);
    if (kind === "into") return true;
    if (kind === "unit" || kind === "empty") {
      units.push({ from: pos, to: pos + node.nodeSize, key: kind === "unit" ? unitKey(node) : null });
    }
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
