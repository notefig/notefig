/**
 * The markdown merge as the sync worker builds it: the DOM shim first (the
 * codec's parser needs a DOM; a worker has none), then one codec for the
 * worker's life, shared by the merge and the block split presence uses
 * (`createWorkerMarkdown`). Loaded by dynamic import on the first merge or
 * the first presence position to map, so a solo worker that never sees a
 * peer never pulls in the codec.
 */
import { installWorkerDomShim } from "@/workers/worker-dom-shim";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { createMarkdownMerge, type MarkdownMerge } from "./merge";
import { splitBlocks } from "./blocks";

export interface WorkerMarkdown {
  merge: MarkdownMerge;
  /** The markdown of each top-level block (`blocks.ts`). */
  splitBlocks: (markdown: string) => string[];
}

export function createWorkerMarkdown(): WorkerMarkdown {
  installWorkerDomShim();
  const codec = createMarkdownCodec();
  return {
    merge: createMarkdownMerge(codec),
    splitBlocks: (markdown) => splitBlocks(codec, markdown),
  };
}

export function createWorkerMerge(): MarkdownMerge {
  return createWorkerMarkdown().merge;
}
