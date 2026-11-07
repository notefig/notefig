/**
 * The markdown merge as the sync worker builds it: the DOM shim first (the
 * codec's parser needs a DOM; a worker has none), then one codec for the
 * worker's life. Loaded by dynamic import on the first merge, so a solo
 * worker never pulls in the codec.
 */
import { installWorkerDomShim } from "@/workers/worker-dom-shim";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { createMarkdownMerge, type MarkdownMerge } from "./merge";

export function createWorkerMerge(): MarkdownMerge {
  installWorkerDomShim();
  return createMarkdownMerge(createMarkdownCodec());
}
