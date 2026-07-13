/**
 * Node view that turns metrists:* code blocks into interactive blob widgets.
 *
 * The ProseMirror node stays a plain codeBlock with language
 * "metrists:<type>" — the schema (editor-schema-kit.ts) and the worker codec
 * are untouched, which is what guarantees the byte-identical markdown
 * round-trip by construction. This component only decorates rendering:
 * parse the YAML lazily, validate against the registry schema, and render
 * the type's Widget; on any parse/validation failure (or an unregistered
 * type) fall back to the ordinary code block with error chrome, plus an
 * "edit as code" escape hatch always available for hand-editing the YAML.
 *
 * codeBlock's content is `text*`, not atom — ProseMirror requires its
 * contentDOM to stay mounted at all times, so the `<pre><code>` (via
 * NodeViewContent) is always rendered and only visually hidden (not
 * unmounted) while a widget is shown on top of it.
 */
import { useState } from "react";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import { BLOB_LANG_PREFIX, parseBlobBlock, type ParsedBlob } from "@metrists/shared/blobs";
import { getBlobType, type BlobTypeDefinition } from "./blob-registry";
import { answerBlob, BlobAnswerError } from "./blob-actions";

export function BlobNodeView(props: NodeViewProps) {
  const language = (props.node.attrs.language as string | null) ?? "";
  const [editAsCode, setEditAsCode] = useState(false);

  const containFocus = () => {
    props.editor.commands.focus(null, { scrollIntoView: false });
  };

  const isBlob = language.startsWith(BLOB_LANG_PREFIX);
  const type = isBlob ? language.slice(BLOB_LANG_PREFIX.length) : undefined;

  let widget:
    | { blobType: BlobTypeDefinition; blob: ParsedBlob; payload: unknown }
    | undefined;
  let errorMessage: string | undefined;

  if (isBlob) {
    const parsed = parseBlobBlock(language, props.node.textContent);
    if (!parsed.ok) {
      errorMessage = `malformed ${language} block: ${parsed.error.message}`;
    } else {
      const blobType = getBlobType(parsed.value.type);
      if (!blobType) {
        errorMessage = `unknown blob type "${type}"`;
      } else {
        const payloadResult = blobType.schema.safeParse(parsed.value.payload);
        if (!payloadResult.success) {
          errorMessage = `invalid ${language} payload: ${payloadResult.error.message}`;
        } else {
          widget = { blobType, blob: parsed.value, payload: payloadResult.data };
        }
      }
    }
  }

  const filePath = (props.extension.options as Record<string, string>).filePath ?? "";

  const answer = widget
    ? async (patch: Record<string, unknown>): Promise<void> => {
        const result = await answerBlob(
          filePath,
          widget.blob.envelope.id,
          widget.blobType.onAnswer(widget.blob, patch),
        );
        if (!result.ok) throw new BlobAnswerError(result.reason);
      }
    : undefined;

  const showCode = editAsCode || !widget;

  return (
    <NodeViewWrapper
      tabIndex={-1}
      onFocus={containFocus}
      data-blob-id={widget?.blob.envelope.id}
      data-blob-type={type}
    >
      {errorMessage && (
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>⚠</span>
          <span>{errorMessage}</span>
        </div>
      )}
      {widget && (
        <div className="rounded border p-3">
          <widget.blobType.Widget
            blob={widget.blob}
            payload={widget.payload}
            answer={answer!}
          />
        </div>
      )}
      {isBlob && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline"
          onClick={() => setEditAsCode((v) => !v)}
        >
          {editAsCode ? "hide code" : "edit as code"}
        </button>
      )}
      <pre hidden={isBlob && !showCode}>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
