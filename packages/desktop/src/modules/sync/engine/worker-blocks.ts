/**
 * Block splits and alignments in the sync worker, cached per version: what
 * presence (cursor anchors) and leases (leased blocks) map positions with.
 * One alignment (`merge/blocks.ts`) is the block identity for the merge,
 * leases and cursors (decision 6); this only remembers its results, so
 * mapping the same peers and leases again on every shared poll re-reads
 * and re-aligns nothing.
 */
import type { GitService } from "@notefig/git";
import { alignBlocks, mapBlockIndexWith } from "../merge/blocks";

export type SplitBlocks = (markdown: string) => string[];

/** How many block splits and alignments a worker keeps. */
const CACHE_LIMIT = 128;

export interface BlockCache {
  blocks: Map<string, string[] | null>;
  alignments: Map<string, number[]>;
}

export function createBlockCache(): BlockCache {
  return { blocks: new Map(), alignments: new Map() };
}

export interface BlockContext {
  service: GitService;
  loadBlocks(): Promise<SplitBlocks>;
  cache: BlockCache;
}

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.set(key, value);
  if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!);
  return value;
}

/** The blocks of `path` at `commit`; null when either isn't here. */
export async function blocksAt(
  ctx: BlockContext,
  commit: string,
  path: string,
): Promise<string[] | null> {
  const key = `${commit}:${path}`;
  if (ctx.cache.blocks.has(key)) {
    const known = ctx.cache.blocks.get(key)!;
    // A miss may be a commit not fetched yet: look again next time.
    if (known) return known;
  }
  let text: string;
  try {
    text = await ctx.service.readTextFile({ ref: commit, filepath: path });
  } catch {
    ctx.cache.blocks.set(key, null);
    return null;
  }
  const split = await ctx.loadBlocks();
  return remember(ctx.cache.blocks, key, split(text));
}

/** Already split (no I/O): for synchronous callers such as the merge's
 *  holder function, after `blocksAt` loaded it. */
export const cachedBlocks = (cache: BlockCache, commit: string, path: string) =>
  cache.blocks.get(`${commit}:${path}`) ?? null;

/** The alignment of two block lists, remembered under `key`. */
export function alignCached(
  cache: BlockCache,
  key: string,
  from: readonly string[],
  to: readonly string[],
): number[] {
  return cache.alignments.get(key) ?? remember(cache.alignments, key, alignBlocks([...from], [...to]));
}

/** Maps block indexes of one version onto another (null: deleted). */
export type IndexMapper = (index: number) => number | null;

export const sameIndex: IndexMapper = (index) => index;

/** Block indexes of `path` at `from`, mapped onto `to`. A version this
 *  clone lacks maps as-is (the next poll fixes it). */
export async function indexMapper(
  ctx: BlockContext,
  path: string,
  from: string | null,
  to: string | null,
): Promise<IndexMapper> {
  if (!from || !to || from === to) return sameIndex;
  const source = await blocksAt(ctx, from, path);
  const target = await blocksAt(ctx, to, path);
  if (!source || !target) return sameIndex;
  const map = alignCached(ctx.cache, `${from}:${to}:${path}`, source, target);
  return (index) => mapBlockIndexWith(map, target.length, index);
}
