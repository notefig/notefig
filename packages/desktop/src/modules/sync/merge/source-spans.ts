/**
 * Where each top-level block of a markdown file sits in its source bytes,
 * so a merge can copy the blocks neither side changed byte for byte
 * instead of re-serializing them. The codec is lossy (it reflows wrapped
 * lines, drops HTML comments, rewrites `_x_` as `*x*`…); a merge that
 * re-serialized a whole file would churn every plain-git collaborator's
 * diff and lose what the codec can't represent.
 *
 * The source is cut into chunks at markdown-it's top-level token
 * boundaries (the frontmatter, split the codec's way, is one more). Each
 * chunk is parsed on its own to learn which canonical blocks it holds:
 * usually one; none for a construct the codec drops (an HTML comment),
 * which then rides along with the chunk before it; several for one the
 * codec splits (raw HTML in a heading). The chunks' blocks, concatenated,
 * must equal the whole document's blocks (`splitBlocks`, the one block
 * identity); when context changes how a chunk parses (a reference link
 * defined elsewhere), they don't, and the file has no spans: the merge
 * serializes its blocks as before.
 *
 * Every byte of the source belongs to exactly one segment, so the
 * segments of an untouched file concatenate back to the file.
 */
import MarkdownIt from "markdown-it";
import { splitFrontmatter } from "@/components/editor/editor-schema-kit";

/** A run of source bytes holding `blocks` consecutive canonical blocks. */
export interface SourceSegment {
  text: string;
  blocks: number;
}

/** Each block's segment, and which of the segment's blocks it is. */
export interface SourceSpans {
  segments: SourceSegment[];
  /** Per canonical block: its segment's index. */
  segmentOf: number[];
}

/** The canonical block texts of a markdown snippet parsed on its own. */
export type ChunkBlocks = (markdown: string) => string[];

// The codec's block grammar (tiptap-markdown builds its markdown-it with
// the same `html` option; plugins only touch inline and core rules).
const blockParser = new MarkdownIt({ html: true });

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** The source cut at top-level block starts; the cuts cover every byte. */
export function sourceChunks(source: string): string[] {
  const { yaml, body } = splitFrontmatter(source);
  const bodyStart = yaml === null ? 0 : source.length - body.length;
  const offsets = lineOffsets(body);
  const starts = blockParser
    .parse(body, {})
    .filter((token) => token.level === 0 && token.nesting !== -1 && token.map)
    .map((token) => offsets[token.map![0]] ?? body.length);
  const cuts = [...new Set([0, ...starts.slice(1)])].filter((at) => at < body.length);
  const chunks = cuts.map((at, i) =>
    body.slice(at, i + 1 < cuts.length ? cuts[i + 1] : body.length),
  );
  if (bodyStart > 0) chunks.unshift(source.slice(0, bodyStart));
  return chunks;
}

/**
 * The source segments of `source`, given its whole-document block texts.
 * Null when the chunks' blocks don't add up to `blocks` (see above).
 */
export function sourceSpans(
  source: string,
  blocks: readonly string[],
  chunkBlocks: ChunkBlocks,
): SourceSpans | null {
  const segments: SourceSegment[] = [];
  const texts: string[] = [];
  let pending = "";
  for (const chunk of sourceChunks(source)) {
    // An empty block is what a dropped construct (a lone HTML comment)
    // leaves when parsed on its own; in the whole document it is gone.
    const found = chunkBlocks(chunk).filter((text) => text !== "");
    if (found.length === 0) {
      // Dropped by the codec: its bytes stay with the block before.
      if (segments.length > 0) segments[segments.length - 1].text += chunk;
      else pending += chunk;
      continue;
    }
    segments.push({ text: pending + chunk, blocks: found.length });
    pending = "";
    texts.push(...found);
  }
  if (pending && segments.length > 0) segments[segments.length - 1].text += pending;
  if (texts.length !== blocks.length || texts.some((text, i) => text !== blocks[i])) {
    return null;
  }
  const segmentOf = segments.flatMap((segment, index) =>
    new Array<number>(segment.blocks).fill(index),
  );
  return { segments, segmentOf };
}
