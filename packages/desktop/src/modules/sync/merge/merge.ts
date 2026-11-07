/**
 * The never-fail markdown 3-way merge of sync mode (MET-271). Runs only in
 * the sync worker (`createSyncMergeDriver`), never on the main thread.
 *
 * One diff3 runs at two levels:
 *  1. blocks: base, ours and theirs are parsed with the markdown codec and
 *     split into top-level ProseMirror blocks (`blocks.ts`, the block
 *     identity leases and cursors share). Each side is aligned to base and
 *     becomes hunks of base blocks it replaced; hunks of the two sides that
 *     don't overlap are all applied, inserts at the same spot holder first;
 *  2. characters: where the two sides' block hunks overlap, a delete
 *     against an edit keeps the edit, and otherwise the blocks are merged
 *     character by character (pairwise when the block counts agree, as one
 *     text otherwise). Character edits are cleaned up first (merged across
 *     short unchanged runs, inserts slid to word boundaries, replacements
 *     widened to whole words); overlapping or touching edits go to the
 *     holder, and the loser's version of that span is returned in
 *     `overwritten`.
 *
 * Bytes: every block a side kept or took whole is copied from that side's
 * source bytes (`source-spans.ts`), so a merge never reflows, re-escapes or
 * drops what the codec can't represent in blocks neither side changed: a
 * block both sides left alone (as the codec reads it) keeps the base's
 * bytes, even where a side re-saved it in the codec's form (an editor save
 * reflows the whole file). Only blocks the character merge produced are
 * serialized, and
 * validation asks that each is stable under the codec (it serializes back
 * to itself); a merge that isn't fails, which is the failsafe's call.
 *
 * Holder: who wins an overlap. A whole side (`"ours"`/`"theirs"`), or a
 * function asked per overlapping run of base blocks (MET-273's leases plug
 * in there; inserts at one spot then go theirs-first).
 *
 * Pure and deterministic: no module, no wiring, never conflict markers.
 * The caller supplies the codec (in a worker, after installWorkerDomShim()).
 */

import { diffChars } from "diff";
import type { JSONContent } from "@tiptap/core";
import type { MarkdownCodec } from "@/components/editor/markdown-codec";
import { alignBlocks, splitBlockNodes } from "./blocks";
import { sourceSpans, type SourceSpans } from "./source-spans";

export type Holder = "ours" | "theirs";

/** An overlap between the sides, as a run of base blocks `[start, end)`. */
export interface BlockSpan {
  start: number;
  end: number;
  /** The base's block texts (`splitBlocks`), to map leases onto. */
  base: readonly string[];
}

/** Who wins the overlap at `span`. */
export type BlockHolder = (span: BlockSpan) => Holder;

export interface MergeInput {
  base: string;
  ours: string;
  theirs: string;
  holder: Holder | BlockHolder;
}

/** How much the two sides' changes collided, in blocks. */
export interface MergeStats {
  /** Blocks theirs (the remote side) changed: replaced, inserted or deleted. */
  theirsChanged: number;
  /** Blocks both sides changed differently (an overlap went to a holder). */
  collided: number;
}

export type MergeResult =
  | { content: string; overwritten: string[]; stats: MergeStats }
  | { failed: string };

export type MarkdownMerge = (input: MergeInput) => MergeResult;

/** Joins blocks into one text when a chunk is merged as a whole. */
const BLOCK_JOIN = "\n\n";
/** Chunk parses kept between merges (by chunk text). */
const CHUNK_CACHE_SIZE = 4_000;

type Side = "base" | "ours" | "theirs";

/** A block in a merge: its canonical text and where it came from. */
interface Block {
  text: string;
  /** `null`: the character merge produced it. */
  from: { side: Side; index: number } | null;
}

/** One version of the document, parsed. */
interface Parsed {
  source: string;
  blocks: Block[];
  nodes: JSONContent[];
  spans: SourceSpans | null;
}

const texts = (blocks: readonly Block[]) => blocks.map((block) => block.text);

export function createMarkdownMerge(codec: MarkdownCodec): MarkdownMerge {
  const chunkCache = new Map<string, string[]>();
  const chunkBlocks = (chunk: string): string[] => {
    const hit = chunkCache.get(chunk);
    if (hit) return hit;
    const found = splitBlockNodes(codec, chunk).map((block) => block.text);
    if (chunkCache.size >= CHUNK_CACHE_SIZE) chunkCache.clear();
    chunkCache.set(chunk, found);
    return found;
  };

  const parse = (source: string, side: Side): Parsed => {
    const split = splitBlockNodes(codec, source);
    const blocks = split.map(({ text }, index) => ({ text, from: { side, index } }));
    return {
      source,
      blocks,
      nodes: split.map(({ node }) => node),
      spans: sourceSpans(source, texts(blocks), chunkBlocks),
    };
  };

  return function merge({ base, ours, theirs, holder }) {
    let sides: Record<Side, Parsed>;
    let merged: Merged<Block[]> & { stats: MergeStats };
    try {
      sides = {
        base: parse(base, "base"),
        ours: parse(ours, "ours"),
        theirs: parse(theirs, "theirs"),
      };
      merged = mergeSides(sides, holder);
    } catch (error) {
      return { failed: `parse: ${String(error)}` };
    }
    try {
      const assembled = assemble(codec, sides, merged.value);
      if ("failed" in assembled) return assembled;
      return { content: assembled.content, overwritten: merged.overwritten, stats: merged.stats };
    } catch (error) {
      return { failed: `assemble: ${String(error)}` };
    }
  };
}

const holderSide = (holder: Holder | BlockHolder): Holder =>
  typeof holder === "function" ? "theirs" : holder;

function mergeSides(
  sides: Record<Side, Parsed>,
  holder: Holder | BlockHolder,
): Merged<Block[]> & { stats: MergeStats } {
  const fixed = holderSide(holder);
  const loser: Holder = fixed === "ours" ? "theirs" : "ours";
  const base = sides.base.blocks;
  const decide =
    typeof holder === "function"
      ? (start: number, end: number) =>
          holder({ start, end, base: texts(base) }) === fixed
      : () => true;
  return mergeBlocks(base, sides[fixed].blocks, sides[loser].blocks, {
    decide,
    theirsIsHolder: fixed === "theirs",
  });
}

// ---------------------------------------------------------------------------
// Assembly: source bytes for kept blocks, the codec for merged ones

type Piece =
  /** `index`: the segment's index in `side`'s spans. */
  | { kind: "source"; side: Side; index: number; text: string; last: boolean }
  | { kind: "serialized"; text: string };


function assemble(
  codec: MarkdownCodec,
  sides: Record<Side, Parsed>,
  blocks: Block[],
): { content: string } | { failed: string } {
  const pieces: Piece[] = [];
  for (let k = 0; k < blocks.length; ) {
    const taken = sourcePiece(sides, blocks, k);
    if (taken) {
      pieces.push(taken.piece);
      k += taken.covers;
      continue;
    }
    const piece = serializedPiece(codec, sides, blocks[k]);
    if ("failed" in piece) return piece;
    pieces.push(piece);
    k += 1;
  }
  return { content: joinPieces(pieces, sides.base.source) };
}

/** The source piece for blocks[k] (and the rest of its segment), if every
 *  block of the segment is there, in order, from the same side. */
function sourcePiece(
  sides: Record<Side, Parsed>,
  blocks: Block[],
  k: number,
): { piece: Piece; covers: number } | null {
  const from = blocks[k].from;
  if (!from) return null;
  const spans = sides[from.side].spans;
  if (!spans) return null;
  const index = spans.segmentOf[from.index];
  const segment = spans.segments[index];
  const first = spans.segmentOf.indexOf(index);
  if (from.index !== first) return null;
  for (let n = 1; n < segment.blocks; n++) {
    const next = blocks[k + n]?.from;
    if (!next || next.side !== from.side || next.index !== from.index + n) return null;
  }
  return {
    piece: {
      kind: "source",
      side: from.side,
      index,
      text: segment.text,
      last: index === spans.segments.length - 1,
    },
    covers: segment.blocks,
  };
}

/** A block the merge produced (or one with no source span), serialized and
 *  checked stable under the codec. */
function serializedPiece(
  codec: MarkdownCodec,
  sides: Record<Side, Parsed>,
  block: Block,
): Piece | { failed: string } {
  if (block.from) {
    // Kept whole, but its side has no spans: the codec's form (always
    // equivalent, so it isn't validated).
    const node = sides[block.from.side].nodes[block.from.index];
    return { kind: "serialized", text: codec.serialize({ type: "doc", content: [node] }) };
  }
  const content = codec.parse(block.text).content ?? [];
  const text = codec.serialize({ type: "doc", content });
  if (codec.serialize(codec.parse(text)) !== text) {
    return { failed: `unstable: a merged block doesn't round-trip (${text.slice(0, 80)})` };
  }
  return { kind: "serialized", text };
}

/**
 * Concatenate the pieces. Consecutive segments of one side's source join
 * as they were; anything else gets a blank line between, so two blocks
 * never run together (a paragraph's lazy continuation). The end of the
 * file keeps the last piece's own ending when that was its source's end,
 * and otherwise ends with a newline if the base did.
 */
function joinPieces(pieces: Piece[], baseSource: string): string {
  let out = "";
  pieces.forEach((piece, i) => {
    const prev = pieces[i - 1];
    const follows =
      prev?.kind === "source" &&
      piece.kind === "source" &&
      prev.side === piece.side &&
      prev.index + 1 === piece.index;
    if (prev && !follows) out = out.replace(/\n*$/, "\n\n");
    out += piece.text;
  });
  const last = pieces[pieces.length - 1];
  if (!last || (last.kind === "source" && last.last)) return out;
  out = out.replace(/\s+$/, "");
  return baseSource.endsWith("\n") ? `${out}\n` : out;
}

// ---------------------------------------------------------------------------
// diff3 over any sequence (a string of characters, an array of blocks)

interface Merged<S> {
  value: S;
  overwritten: string[];
}

interface Seq<S> {
  length(s: S): number;
  slice(s: S, start: number, end: number): S;
  concat(parts: S[]): S;
  equal(a: S, b: S): boolean;
}

const TEXT: Seq<string> = {
  length: (s) => s.length,
  slice: (s, a, b) => s.slice(a, b),
  concat: (parts) => parts.join(""),
  equal: (a, b) => a === b,
};

const BLOCKS: Seq<Block[]> = {
  length: (s) => s.length,
  slice: (s, a, b) => s.slice(a, b),
  concat: (parts) => parts.flat(),
  equal: (a, b) => a.length === b.length && a.every((block, i) => block.text === b[i].text),
};

interface Hunk<S> {
  /** Base range [start, end) replaced by `insert`. */
  start: number;
  end: number;
  insert: S;
  holder: boolean;
}

/** The overlapping run `[start, end)` of base, each side's version of it. */
interface Conflict<S> {
  start: number;
  end: number;
  span: S;
  mine: S;
  other: S;
}

/** Hunks that overlap (transitively, or touching with `touching`) group. */
function clusterHunks<S>(sorted: Hunk<S>[], touching: boolean): Hunk<S>[][] {
  const clusters: Hunk<S>[][] = [];
  let cStart = -1;
  let cEnd = -1;
  const joins = (hunk: Hunk<S>) =>
    clusters.length > 0 &&
    ((hunk.start < cEnd && cStart < hunk.end) ||
      (touching &&
        hunk.start <= cEnd &&
        cStart <= hunk.end &&
        // Two inserts at one spot stay separate: both kept, holder first.
        !(hunk.start === hunk.end && cStart === cEnd)));
  for (const hunk of sorted) {
    if (joins(hunk)) {
      clusters[clusters.length - 1].push(hunk);
      cEnd = Math.max(cEnd, hunk.end);
    } else {
      clusters.push([hunk]);
      cStart = hunk.start;
      cEnd = hunk.end;
    }
  }
  return clusters;
}

/**
 * Applies both sides' hunks to `base`. A change both sides made identically
 * is applied once. Hunks that overlap (transitively) form a cluster; a
 * cluster with hunks from both sides is handed to `conflict` with the base
 * span and each side's version of it. With `touching`, hunks that only
 * touch also cluster; either way two inserts at the same spot are both
 * applied, holder's first.
 */
function diff3<S>(
  seq: Seq<S>,
  base: S,
  hunks: Hunk<S>[],
  touching: boolean,
  conflict: (c: Conflict<S>) => Merged<S>,
): Merged<S> {
  const same = (x: Hunk<S>, y: Hunk<S>) =>
    x.start === y.start && x.end === y.end && seq.equal(x.insert, y.insert);
  const mineAll = hunks.filter((x) => x.holder);
  const sorted = hunks
    .filter((x) => x.holder || !mineAll.some((y) => same(x, y)))
    .sort(
      (x, y) =>
        x.start - y.start || x.end - y.end || Number(y.holder) - Number(x.holder),
    );

  const parts: S[] = [];
  const overwritten: string[] = [];
  let pos = 0;
  for (const cluster of clusterHunks(sorted, touching)) {
    const start = cluster[0].start;
    const end = Math.max(...cluster.map((x) => x.end));
    parts.push(seq.slice(base, pos, start));
    const mine = cluster.filter((x) => x.holder);
    const other = cluster.filter((x) => !x.holder);
    if (mine.length && other.length) {
      const r = conflict({
        start,
        end,
        span: seq.slice(base, start, end),
        mine: apply(seq, base, start, end, mine),
        other: apply(seq, base, start, end, other),
      });
      parts.push(r.value);
      overwritten.push(...r.overwritten);
    } else {
      parts.push(apply(seq, base, start, end, cluster));
    }
    pos = end;
  }
  parts.push(seq.slice(base, pos, seq.length(base)));
  return { value: seq.concat(parts), overwritten };
}

/** base[start, end) with one side's sorted, non-overlapping hunks applied. */
function apply<S>(seq: Seq<S>, base: S, start: number, end: number, hunks: Hunk<S>[]): S {
  const parts: S[] = [];
  let pos = start;
  for (const hunk of hunks) {
    parts.push(seq.slice(base, pos, hunk.start), hunk.insert);
    pos = hunk.end;
  }
  parts.push(seq.slice(base, pos, end));
  return seq.concat(parts);
}

// ---------------------------------------------------------------------------
// Block level

/** The runs of base blocks `side` replaced, from the block alignment. */
function blockHunks(b: Block[], side: Block[], holder: boolean): Hunk<Block[]>[] {
  const map = alignBlocks(texts(b), texts(side));
  const hunks: Hunk<Block[]>[] = [];
  let lastB = -1;
  let lastS = -1;
  const close = (i: number, j: number) => {
    if (i > lastB + 1 || j > lastS + 1) {
      hunks.push({ start: lastB + 1, end: i, insert: side.slice(lastS + 1, j), holder });
    }
  };
  map.forEach((j, i) => {
    if (j < 0) return;
    close(i, j);
    lastB = i;
    lastS = j;
  });
  close(b.length, side.length);
  return hunks;
}

const changedBlocks = (hunks: Hunk<Block[]>[]) =>
  hunks.reduce((n, h) => n + Math.max(h.end - h.start, h.insert.length), 0);

const mergedBlock = (text: string): Block => ({ text, from: null });

/** An overlapping run of blocks, `h` holding (`l` loses). */
function resolveBlocks(span: Block[], h: Block[], l: Block[]): Merged<Block[]> {
  // A delete against an edit keeps the edit.
  if (h.length === 0) return { value: l, overwritten: [] };
  if (l.length === 0) return { value: h, overwritten: [] };
  if (span.length === h.length && span.length === l.length) {
    const out = span.map((base, i) => mergeText(base.text, h[i].text, l[i].text));
    return {
      value: out.map((r, i) =>
        r.text === h[i].text ? h[i] : r.text === l[i].text ? l[i] : mergedBlock(r.text),
      ),
      overwritten: out.flatMap((r) => r.overwritten),
    };
  }
  const join = (blocks: Block[]) => texts(blocks).join(BLOCK_JOIN);
  const r = mergeText(join(span), join(h), join(l));
  if (r.text === join(h)) return { value: h, overwritten: r.overwritten };
  return { value: [mergedBlock(r.text)], overwritten: r.overwritten };
}

/**
 * 3-way merge of block sequences; `h` is the default holder's side, `l`
 * the other. `decide(start, end)` says whether `h` holds the overlap at
 * base `[start, end)` (default: always).
 */
export function mergeBlocks(
  b: Block[],
  h: Block[],
  l: Block[],
  options: { decide?: (start: number, end: number) => boolean; theirsIsHolder?: boolean } = {},
): Merged<Block[]> & { stats: MergeStats } {
  const hHunks = blockHunks(b, h, true);
  const lHunks = blockHunks(b, l, false);
  const stats: MergeStats = {
    theirsChanged: changedBlocks(options.theirsIsHolder === false ? lHunks : hHunks),
    collided: 0,
  };
  const merged = diff3(BLOCKS, b, [...hHunks, ...lHunks], false, (c) => {
    stats.collided += Math.max(c.span.length, c.mine.length, c.other.length);
    const holds = options.decide?.(c.start, c.end) ?? true;
    return holds ? resolveBlocks(c.span, c.mine, c.other) : resolveBlocks(c.span, c.other, c.mine);
  });
  return { ...merged, stats };
}

// ---------------------------------------------------------------------------
// Character level

function textHunks(base: string, side: string, holder: boolean): Hunk<string>[] {
  const hunks: Hunk<string>[] = [];
  let pos = 0;
  let current: Hunk<string> | null = null;
  for (const part of diffChars(base, side)) {
    if (!part.added && !part.removed) {
      if (current) hunks.push(current);
      current = null;
      pos += part.value.length;
      continue;
    }
    current ??= { start: pos, end: pos, insert: "", holder };
    if (part.removed) {
      current.end += part.value.length;
      pos += part.value.length;
    } else {
      current.insert += part.value;
    }
  }
  if (current) hunks.push(current);
  const trimmed = cleanupSemantic(base, hunks)
    .map((h) => trim(base, h))
    .filter((h) => h.start !== h.end || h.insert !== "");
  return snapToWords(base, side, slideToBoundaries(base, trimmed));
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Widens every edit that starts or ends inside a word to the whole word,
 * merging the edits that then touch. A raw character diff splits a
 * rewritten word along the letters it happens to share with the new one
 * ("this" → "tbrisk" keeps the t, i, s), and two such rewrites would
 * interleave; at word granularity they overlap and the holder wins whole.
 * Pure inserts are left alone, so inserts at the same spot are still both
 * kept, holder's first.
 */
function snapToWords(base: string, side: string, hunks: Hunk<string>[]): Hunk<string>[] {
  const inside = (p: number) =>
    p > 0 && p < base.length && WORD.test(base[p - 1]) && WORD.test(base[p]);
  const groups: Array<{ start: number; end: number; members: Hunk<string>[] }> = [];
  for (const hunk of hunks) {
    let { start, end } = hunk;
    if (start !== end) {
      while (inside(start)) start--;
      while (inside(end)) end++;
    }
    const last = groups[groups.length - 1];
    if (last && start <= last.end && !(start === end && last.start === last.end)) {
      last.end = Math.max(last.end, end);
      last.members.push(hunk);
    } else {
      groups.push({ start, end, members: [hunk] });
    }
  }
  // Base offsets outside every hunk map to the side by the length change
  // of the hunks before them.
  let delta = 0;
  return groups.map(({ start, end, members }) => {
    const grow = members.reduce((n, h) => n + h.insert.length - (h.end - h.start), 0);
    const from = start + delta;
    delta += grow;
    return { start, end, insert: side.slice(from, from + end - start + grow), holder: members[0].holder };
  });
}

/** Drops what a hunk's removed and inserted text share at either end. */
function trim(base: string, hunk: Hunk<string>): Hunk<string> {
  const removed = base.slice(hunk.start, hunk.end);
  const { insert } = hunk;
  let pre = 0;
  while (pre < removed.length && pre < insert.length && removed[pre] === insert[pre]) pre++;
  let suf = 0;
  while (
    suf < removed.length - pre &&
    suf < insert.length - pre &&
    removed[removed.length - 1 - suf] === insert[insert.length - 1 - suf]
  ) {
    suf++;
  }
  return {
    ...hunk,
    start: hunk.start + pre,
    end: hunk.end - suf,
    insert: insert.slice(pre, insert.length - suf),
  };
}

const edgeScore = (a: string | undefined, b: string | undefined) =>
  a === undefined || b === undefined || /[\s\p{P}]/u.test(a) || /[\s\p{P}]/u.test(b) ? 1 : 0;

/** Slide one pure insert to the boundary-friendliest equivalent offset. */
function slideInsert(base: string, hunk: Hunk<string>, lo: number, hi: number): Hunk<string> {
  let { start, insert } = hunk;
  while (start > lo && base[start - 1] === insert[insert.length - 1]) {
    insert = insert[insert.length - 1] + insert.slice(0, -1);
    start--;
  }
  let best = { start, insert, score: -1 };
  for (;;) {
    const score = edgeScore(base[start - 1], insert[0]) + edgeScore(insert[insert.length - 1], base[start]);
    if (score > best.score) best = { start, insert, score };
    if (start >= hi || base[start] !== insert[0]) break;
    insert = insert.slice(1) + insert[0];
    start++;
  }
  return { ...hunk, start: best.start, end: best.start, insert: best.insert };
}

/** Slide one pure delete the same way. */
function slideDelete(base: string, hunk: Hunk<string>, lo: number, hi: number): Hunk<string> {
  let { start, end } = hunk;
  while (start > lo && base[start - 1] === base[end - 1]) {
    start--;
    end--;
  }
  let best = { start, end, score: -1 };
  for (;;) {
    const score = edgeScore(base[start - 1], base[start]) + edgeScore(base[end - 1], base[end]);
    if (score > best.score) best = { start, end, score };
    if (end >= hi || base[start] !== base[end]) break;
    start++;
    end++;
  }
  return { ...hunk, start: best.start, end: best.end };
}

/**
 * A pure insert or delete can often sit at several equivalent offsets
 * (inserting " big" into "a cat" is also "a" + "big " + " cat"…), and which
 * one the diff reports is arbitrary. Slide each to the offset whose edges
 * fall on whitespace or punctuation (diff-match-patch's lossless cleanup),
 * so two people typing at neighbouring words don't get hunks that touch.
 */
function slideToBoundaries(base: string, hunks: Hunk<string>[]): Hunk<string>[] {
  return hunks.map((hunk, i) => {
    const lo = i > 0 ? hunks[i - 1].end : 0;
    const hi = i + 1 < hunks.length ? hunks[i + 1].start : base.length;
    if (hunk.start === hunk.end) return slideInsert(base, hunk, lo, hi);
    if (hunk.insert === "") return slideDelete(base, hunk, lo, hi);
    return hunk;
  });
}

/**
 * A raw character diff matches stray letters inside rewritten text
 * ("here." → "rewritten" keeps the e, r, e), which splits one rewrite
 * into many small hunks that the other side's edit can interleave with.
 * As in diff-match-patch's semantic cleanup, an unchanged run between two
 * hunks is absorbed when it is no longer than the edit on either side.
 */
function cleanupSemantic(base: string, hunks: Hunk<string>[]): Hunk<string>[] {
  const size = (h: Hunk<string>) => Math.max(h.end - h.start, h.insert.length);
  const out: Hunk<string>[] = [];
  for (const hunk of hunks) {
    const prev = out[out.length - 1];
    const gap = prev ? hunk.start - prev.end : Infinity;
    if (prev && gap <= size(prev) && gap <= size(hunk)) {
      prev.insert += base.slice(prev.end, hunk.start) + hunk.insert;
      prev.end = hunk.end;
    } else {
      out.push({ ...hunk });
    }
  }
  return out;
}

/**
 * Character-level diff3: edits to different ranges are both kept, inserts
 * at the same spot holder first, and where the edits overlap or touch the
 * holder's version wins and the loser's version is returned as
 * overwritten. (Touching counts at this level so a rewrite that the diff
 * splits into a replacement plus an adjacent insert can't half survive
 * next to the holder's; whole blocks touching is fine, see mergeBlocks.)
 */
export function mergeText(base: string, h: string, l: string): { text: string; overwritten: string[] } {
  if (l === base || h === l) return { text: h, overwritten: [] };
  if (h === base) return { text: l, overwritten: [] };
  const r = diff3(
    TEXT,
    base,
    [...textHunks(base, h, true), ...textHunks(base, l, false)],
    true,
    ({ mine, other }) => ({ value: mine, overwritten: mine === other ? [] : [other] }),
  );
  return { text: r.value, overwritten: r.overwritten };
}
