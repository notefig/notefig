/**
 * Block positions (`SyncBlockPosition`) ↔ ProseMirror positions in an open
 * document. A block is one top-level node (decision 17); the offset counts
 * ProseMirror positions from just before it. Both directions are a walk
 * over the top-level children only — cheap, and done only when a caret is
 * published (throttled) or remote presence changes, never per keystroke.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { SyncBlockPosition } from "./document-channel";

/** Where `pos` is, as a top-level block and an offset into it. */
export function toBlockPosition(doc: PMNode, pos: number): SyncBlockPosition {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  const blockIndex = Math.min($pos.index(0), Math.max(0, doc.childCount - 1));
  return { blockIndex, offset: clamped - blockStart(doc, blockIndex) };
}

/** The position just before top-level block `index`. */
function blockStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * A block position in `doc`, clamped inside the block (its offset may come
 * from a version where the block was longer); null when the block isn't
 * there (the document is shorter).
 */
export function fromBlockPosition(doc: PMNode, position: SyncBlockPosition): number | null {
  if (position.blockIndex < 0 || position.blockIndex >= doc.childCount) return null;
  const start = blockStart(doc, position.blockIndex);
  const node = doc.child(position.blockIndex);
  const inside = node.isLeaf ? 0 : Math.max(1, Math.min(position.offset, node.nodeSize - 1));
  return start + inside;
}
