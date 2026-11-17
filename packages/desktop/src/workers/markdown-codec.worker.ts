/**
 * Markdown conversion worker: the only place markdown ↔ ProseMirror-doc
 * conversion runs in production. Stateless — each call is a pure function of
 * its arguments, so all per-file bookkeeping (coalescing, baselines, write
 * queues) stays on the main thread in utils/markdown-conversion.ts.
 */

import { installWorkerDomShim } from "./worker-dom-shim";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { renderMarkdownHtml } from "@/utils/markdown-html";
import { exposeWorkerApi } from "@notefig/worker";
import type { JSONContent } from "@tiptap/core";
import type { MergedMarkdown } from "@/modules/sync/sync-merge";
import { serializeKeeping, type SavedSource } from "@/utils/markdown-units";

installWorkerDomShim();
const codec = createMarkdownCodec();

const api = {
  parse(markdown: string): JSONContent {
    return codec.parse(markdown);
  },
  /** The save: what didn't change since `previous` keeps its bytes. */
  serialize(doc: JSONContent, previous: SavedSource | null = null) {
    return serializeKeeping(codec, doc, previous);
  },
  renderHtml(markdown: string): string {
    return renderMarkdownHtml(markdown);
  },
  /** Sync's three-way merge (`modules/sync/sync-merge.ts`), loaded on the
   *  first call: a workspace that doesn't sync never loads it. */
  async merge(base: string, ours: string, theirs: string): Promise<MergedMarkdown> {
    const { mergeMarkdown } = await import("@/modules/sync/sync-merge");
    return mergeMarkdown(base, ours, theirs);
  },
};

export type MarkdownWorkerApi = typeof api;

exposeWorkerApi(api);
