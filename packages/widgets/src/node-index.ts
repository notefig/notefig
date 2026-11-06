/**
 * Where a document's indexed nodes are, kept by one plugin so its readers
 * don't each walk the whole document on every transaction. A node type is
 * indexed when its extension says `indexed: true`; the index lists every
 * node of those types, in document order.
 *
 * An edit only rescans what it touched: every entry moves through the
 * edit's mapping, and only the entries around a changed range are dropped
 * and found again — typing in a paragraph of a long document costs the
 * length of its index, not of the document. A step it can't place (one it
 * doesn't know) rescans the whole document.
 *
 * Block nodes only: the index never looks inside a textblock.
 */
import { Extension, getExtensionField } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from "@tiptap/pm/transform";

declare module "@tiptap/core" {
  interface NodeConfig<Options, Storage> {
    /** Listed by the node index (./node-index.ts), for `indexedNodes`. */
    indexed?: boolean;
  }
}

export interface IndexedNode {
  pos: number;
  node: PMNode;
}

const key = new PluginKey<readonly IndexedNode[]>("nodeIndex");

/** Every node of `type` in `state`'s document, in order. */
export function indexedNodes(state: EditorState, type: string): IndexedNode[] {
  const index = key.getState(state);
  if (!index) throw new Error("The node index isn't installed in this editor");
  return index.filter((entry) => entry.node.type.name === type);
}

/** Every node of `types` in `doc`, or in `doc` from `from` to `to`. */
function scan(doc: PMNode, types: ReadonlySet<string>, from = 0, to = doc.content.size): IndexedNode[] {
  const found: IndexedNode[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (types.has(node.type.name)) found.push({ pos, node });
    return !node.isTextblock;
  });
  return found;
}

/** The range a step changed in the document it applied to, or null for a
 *  step this doesn't know. */
function stepRange(step: Step): { from: number; to: number } | null {
  if (
    step instanceof ReplaceStep ||
    step instanceof ReplaceAroundStep ||
    step instanceof AddMarkStep ||
    step instanceof RemoveMarkStep
  ) {
    return { from: step.from, to: step.to };
  }
  if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
    return { from: step.pos, to: step.pos + 1 };
  }
  return null;
}

/** What `tr` changed in its final document, a position either side so a
 *  node beside a change is found again too: sorted and joined. Null when
 *  a step can't be placed. */
function changedRanges(tr: Transaction): Array<{ from: number; to: number }> | null {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < tr.steps.length; index++) {
    const step = tr.steps[index];
    // A document's attribute changes no node in it.
    if (step instanceof DocAttrStep) continue;
    const range = stepRange(step);
    if (!range) return null;
    const after = tr.mapping.slice(index);
    ranges.push({
      from: Math.max(0, after.map(range.from, -1) - 1),
      to: Math.min(tr.doc.content.size, after.map(range.to, 1) + 1),
    });
  }
  ranges.sort((a, b) => a.from - b.from);
  const joined: typeof ranges = [];
  for (const range of ranges) {
    const last = joined[joined.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else joined.push(range);
  }
  return joined;
}

function update(tr: Transaction, index: readonly IndexedNode[], types: ReadonlySet<string>): readonly IndexedNode[] {
  if (!tr.docChanged) return index;
  const ranges = changedRanges(tr);
  if (!ranges) return scan(tr.doc, types);
  // Overlapping, as nodesBetween finds a node: the same test drops an entry
  // and finds it again.
  const touched = (from: number, to: number) => ranges.some((range) => from < range.to && to > range.from);
  const kept: IndexedNode[] = [];
  for (const { pos, node } of index) {
    const start = tr.mapping.mapResult(pos, 1);
    // A deleted node can map onto the document's end, outside every range.
    if (start.deletedAfter) continue;
    const to = tr.mapping.map(pos + node.nodeSize, -1);
    if (!touched(start.pos, to)) kept.push({ pos: start.pos, node });
  }
  const seen = new Set<number>();
  const found = ranges
    .flatMap((range) => scan(tr.doc, types, range.from, range.to))
    // An ancestor across two ranges is found by both.
    .filter(({ pos }) => !seen.has(pos) && Boolean(seen.add(pos)));
  return found.length === 0 ? kept : [...kept, ...found].sort((a, b) => a.pos - b.pos);
}

/** The index's plugin over the given node types. NodeIndex installs it for
 *  every node extension marked `indexed`; a bare EditorState (a test) can
 *  install it directly. */
export function nodeIndexPlugin(types: ReadonlySet<string>): Plugin<readonly IndexedNode[]> {
  return new Plugin<readonly IndexedNode[]>({
    key,
    state: {
      init: (_config, { doc }) => scan(doc, types),
      apply: (tr, index) => update(tr, index, types),
    },
  });
}

export const NodeIndex = Extension.create({
  name: "nodeIndex",
  // Its state first, so another plugin's `apply` reads this transaction's.
  priority: 10_000,

  addProseMirrorPlugins() {
    const types = new Set(
      this.editor.extensionManager.extensions
        .filter((extension) => extension.type === "node" && getExtensionField(extension, "indexed"))
        .map((extension) => extension.name),
    );
    return [nodeIndexPlugin(types)];
  },
});
