/**
 * Editor-free markdown ↔ ProseMirror-doc codec.
 *
 * Reuses tiptap-markdown's real MarkdownParser/MarkdownSerializer so output
 * is byte-identical to `editor.storage.markdown.getMarkdown()` — but without
 * a live Editor, so it can run inside the conversion Web Worker (with a DOM
 * shim, see workers/worker-dom-shim.ts) or on the main thread as a fallback.
 *
 * tiptap-markdown does not export its parser/serializer classes, only the
 * `Markdown` extension. Its `onBeforeCreate` hook constructs both onto
 * `editor.storage.markdown` using nothing but `editor.schema`,
 * `editor.extensionManager.extensions`, and `editor.options.content` — all
 * of which we can supply on a plain object. Pinned by the equivalence tests
 * in __tests__/markdown-codec.test.ts.
 */

import {
  createNodeFromContent,
  getSchemaByResolvedExtensions,
  resolveExtensions,
  type JSONContent,
} from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { createSchemaExtensions } from "./editor-schema-kit";
import { calculateContentHash } from "@/utils/hash";

export interface MarkdownCodec {
  /** markdown string → ProseMirror doc JSON (same result as editor setContent) */
  parse(markdown: string): JSONContent;
  /** ProseMirror doc JSON → markdown (same result as getMarkdown()) */
  serialize(doc: JSONContent): string;
  /** MD5 content hash, matching hash.ts / the Rust watcher */
  hash(content: string): string;
}

interface MarkdownStorage {
  options: Record<string, unknown>;
  parser: { parse(content: string): string };
  serializer: { serialize(content: PMNode): string };
}

export function createMarkdownCodec(): MarkdownCodec {
  const extensions = resolveExtensions(createSchemaExtensions());
  const schema = getSchemaByResolvedExtensions(extensions);
  const markdownExtension = extensions.find((e) => e.name === "markdown");
  if (!markdownExtension) {
    throw new Error("Markdown extension missing from schema kit");
  }

  // The minimal editor surface tiptap-markdown's onBeforeCreate + the bound
  // serialize/parse spec functions actually touch.
  const fakeEditor = {
    schema,
    extensionManager: { extensions },
    storage: {} as { markdown?: MarkdownStorage },
    options: { content: "" as unknown },
  };

  const onBeforeCreate = (
    markdownExtension.config as unknown as {
      onBeforeCreate: (this: {
        editor: typeof fakeEditor;
        options: unknown;
      }) => void;
    }
  ).onBeforeCreate;
  onBeforeCreate.call({
    editor: fakeEditor,
    options: markdownExtension.options,
  });

  const { parser, serializer } = fakeEditor.storage.markdown!;

  return {
    parse(markdown: string): JSONContent {
      // parser.parse returns an HTML string; createNodeFromContent with
      // slice:false is exactly what the editor's setContent does with it.
      const html = parser.parse(markdown ?? "");
      const doc = createNodeFromContent(html, schema, { slice: false });
      return (doc as PMNode).toJSON() as JSONContent;
    },

    serialize(doc: JSONContent): string {
      return serializer.serialize(PMNode.fromJSON(schema, doc));
    },

    hash: calculateContentHash,
  };
}
