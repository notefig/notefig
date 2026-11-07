/**
 * Block identity for sync mode: the one alignment shared by the merge,
 * leases and cursor anchors (sync brief, decision 6). Blocks are never
 * stored with ids; a block in one version of a document is found in
 * another by aligning their top-level blocks.
 *
 * A block is one top-level ProseMirror node, serialized on its own (a
 * whole list or table is one block).
 */

import type { JSONContent } from "@tiptap/core";
import type { MarkdownCodec } from "@/components/editor/markdown-codec";

type Codec = Pick<MarkdownCodec, "parse" | "serialize">;

/** Each top-level block of `markdown`, in order: its node and its markdown. */
export function splitBlockNodes(
  codec: Codec,
  markdown: string,
): Array<{ node: JSONContent; text: string }> {
  return (codec.parse(markdown).content ?? []).map((node) => ({
    node,
    text: codec.serialize({ type: "doc", content: [node] }),
  }));
}

/** The markdown of each top-level block of `markdown`, in order. */
export function splitBlocks(codec: Codec, markdown: string): string[] {
  return splitBlockNodes(codec, markdown).map((block) => block.text);
}

/**
 * For each index of `from`, the index of the identical block of `to` it
 * matches in a longest common subsequence, or -1. Backtracking takes a
 * match as early as it can and otherwise advances `from` first, so the
 * same pair of documents always gives the same alignment.
 */
export function alignBlocks(from: string[], to: string[]): number[] {
  const n = from.length;
  const m = to.length;
  const w = m + 1;
  const len = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] =
        from[i] === to[j]
          ? len[(i + 1) * w + j + 1] + 1
          : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  const map = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      map[i++] = j++;
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

/**
 * Where block `index` of `from` is in `to`: its identical block if it is
 * unchanged; otherwise the block at the same offset among the changed
 * blocks between the nearest unchanged neighbours (an edited block keeps
 * its identity); `null` when that stretch is empty in `to` (deleted).
 */
export function mapBlockIndex(
  from: string[],
  to: string[],
  index: number,
): number | null {
  if (index < 0 || index >= from.length) return null;
  const map = alignBlocks(from, to);
  if (map[index] >= 0) return map[index];
  let prev = index - 1;
  while (prev >= 0 && map[prev] < 0) prev--;
  let next = index + 1;
  while (next < from.length && map[next] < 0) next++;
  const lo = prev >= 0 ? map[prev] + 1 : 0;
  const hi = next < from.length ? map[next] : to.length;
  if (hi <= lo) return null;
  return Math.min(lo + (index - prev - 1), hi - 1);
}
