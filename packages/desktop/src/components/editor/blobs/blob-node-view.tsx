/**
 * Node view that turns metrists:* code blocks into interactive blob widgets.
 *
 * The ProseMirror node stays a plain codeBlock with language
 * "metrists:<type>" — the schema (editor-schema-kit.ts) and the worker codec
 * are untouched, which is what guarantees the byte-identical markdown
 * round-trip by construction. This component only decorates rendering:
 * parse the YAML lazily, validate against the registry schema, and render
 * the type's Widget; on any parse/validation failure fall back to the
 * ordinary code block with error chrome.
 *
 * Wiring (phase 2): tiptap-editor-kit.tsx extends CodeBlockLowlight with a
 * ReactNodeViewRenderer that chooses this component when the language attr
 * starts with BLOB_LANG_PREFIX, and the default code view otherwise.
 */
import { BLOB_LANG_PREFIX } from "@metrists/shared/blobs";

export type BlobNodeViewProps = {
  /** Full language attr, e.g. "metrists:question" */
  language: string;
  /** Fence body (YAML) */
  code: string;
  filePath: string;
};

export function BlobNodeView({ language }: BlobNodeViewProps) {
  const type = language.slice(BLOB_LANG_PREFIX.length);
  // TODO(phase 2): parseBlobBlock + getBlobType(type) + Widget with
  // answer() bound through blob-actions.answerBlob.
  return (
    <div data-blob-type={type} className="rounded border border-dashed p-2">
      blob: {type} (not implemented)
    </div>
  );
}
