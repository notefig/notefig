import type { BlobLocation, ParsedBlob } from "./blob-envelope";

/**
 * Pure-text blob codec. No editor, no DOM: callable from the desktop app,
 * the conversion worker, and the CLI worker alike.
 *
 * Invariants (property-tested once implemented):
 * - A blob is only ever rewritten by string surgery on its own fenced block;
 *   the rest of the document is never re-serialized.
 * - Unknown YAML keys, key order, and comments survive parse → patch →
 *   serialize (which is why implementations must use the `yaml` package's
 *   document API, not a plain load/dump cycle).
 * - Text that fails to parse as a blob round-trips byte-identically as an
 *   ordinary code block.
 */

export type BlobParseErrorType =
  | "not_a_blob" // language tag lacks the metrists: prefix
  | "invalid_yaml"
  | "invalid_envelope"; // YAML ok but envelope schema failed

export class BlobParseError extends Error {
  constructor(
    readonly type: BlobParseErrorType,
    message?: string,
  ) {
    super(message ?? type.replace(/_/g, " "));
    this.name = "BlobParseError";
  }
}

export type BlobPatchErrorType =
  | "not_found" // no fenced block with that blob id in the markdown
  | "conflict" // block exists but no longer parses as the same blob
  | "invalid_patch";

export class BlobPatchError extends Error {
  constructor(
    readonly type: BlobPatchErrorType,
    readonly blobId: string,
    message?: string,
  ) {
    super(message ?? `${type.replace(/_/g, " ")}: ${blobId}`);
    this.name = "BlobPatchError";
  }
}

export type BlobResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Parse one fenced block's language tag + body into a blob.
 */
export function parseBlobBlock(
  _langTag: string,
  _yamlText: string,
): BlobResult<ParsedBlob, BlobParseError> {
  // TODO(phase 2): implement with the `yaml` document API + BlobEnvelopeSchema.
  throw new Error("not implemented: parseBlobBlock");
}

/**
 * Serialize a blob back to its full fenced-block text (fences included),
 * preserving payload key order and comments where they exist.
 */
export function serializeBlobBlock(_blob: ParsedBlob): string {
  // TODO(phase 2)
  throw new Error("not implemented: serializeBlobBlock");
}

/**
 * Find every metrists:* fenced block in a markdown document.
 * Blocks that fail blob parsing are skipped (they render as plain code).
 */
export function findBlobs(_markdown: string): BlobLocation[] {
  // TODO(phase 2)
  throw new Error("not implemented: findBlobs");
}

/**
 * Apply a shallow payload patch to the blob with `blobId`, rewriting only
 * that fenced block. This is the concurrent-safety primitive: ID-addressed,
 * not offset-addressed, so it stays correct after unrelated edits.
 */
export function patchBlobInMarkdown(
  _markdown: string,
  _blobId: string,
  _patch: Record<string, unknown>,
): BlobResult<string, BlobPatchError> {
  // TODO(phase 2)
  throw new Error("not implemented: patchBlobInMarkdown");
}
