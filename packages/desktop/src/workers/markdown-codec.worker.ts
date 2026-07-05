/**
 * Markdown conversion worker: the only place markdown ↔ ProseMirror-doc
 * conversion runs in production. Stateless — each call is a pure function of
 * its arguments, so all per-file bookkeeping (coalescing, baselines, write
 * queues) stays on the main thread in utils/markdown-conversion.ts.
 */

import { installWorkerDomShim } from "./worker-dom-shim";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { exposeWorkerApi } from "./worker-rpc";
import type { JSONContent } from "@tiptap/core";

installWorkerDomShim();
const codec = createMarkdownCodec();

const api = {
  parse(markdown: string): JSONContent {
    return codec.parse(markdown);
  },
  serialize(doc: JSONContent): { markdown: string; hash: string } {
    const markdown = codec.serialize(doc);
    return { markdown, hash: codec.hash(markdown) };
  },
};

export type MarkdownWorkerApi = typeof api;

exposeWorkerApi(api);
