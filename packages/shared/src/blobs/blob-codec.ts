import { Document, parseDocument } from "yaml";
import type { BlobLocation, ParsedBlob } from "./blob-envelope";
import { BLOB_LANG_PREFIX, BlobEnvelopeSchema } from "./blob-envelope";

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
 * Matches a fenced code block whose language tag starts with `metrists:`,
 * capturing the type suffix and body. Non-greedy body match stops at the
 * first closing fence on its own line, on either LF or CRLF line endings.
 */
const BLOB_FENCE_PATTERN =
  /```metrists:([a-zA-Z0-9_-]+)\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Parse one fenced block's language tag + body into a blob.
 */
export function parseBlobBlock(
  langTag: string,
  yamlText: string,
): BlobResult<ParsedBlob, BlobParseError> {
  if (!langTag.startsWith(BLOB_LANG_PREFIX)) {
    return { ok: false, error: new BlobParseError("not_a_blob") };
  }
  const type = langTag.slice(BLOB_LANG_PREFIX.length);

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      error: new BlobParseError("invalid_yaml", doc.errors[0].message),
    };
  }

  const payload = (doc.toJS() ?? {}) as Record<string, unknown>;
  const parsedEnvelope = BlobEnvelopeSchema.safeParse(payload);
  if (!parsedEnvelope.success) {
    return {
      ok: false,
      error: new BlobParseError(
        "invalid_envelope",
        parsedEnvelope.error.message,
      ),
    };
  }

  return {
    ok: true,
    value: {
      type,
      envelope: parsedEnvelope.data,
      payload,
      rawYaml: yamlText,
    },
  };
}

/**
 * Serialize a blob back to its full fenced-block text (fences included).
 * Used for freshly-authored blobs with no prior document to preserve — for
 * patching an *existing* fence in place (preserving comments/order/unknown
 * keys), use `patchBlobInMarkdown`, which operates on the yaml document
 * directly rather than round-tripping through this function.
 */
export function serializeBlobBlock(blob: ParsedBlob): string {
  const doc = new Document(blob.payload);
  const body = doc.toString().trimEnd();
  return `\`\`\`${BLOB_LANG_PREFIX}${blob.type}\n${body}\n\`\`\`\n`;
}

/**
 * Find every metrists:* fenced block in a markdown document.
 * Blocks that fail blob parsing are skipped (they render as plain code).
 */
export function findBlobs(markdown: string): BlobLocation[] {
  const locations: BlobLocation[] = [];
  for (const match of markdown.matchAll(BLOB_FENCE_PATTERN)) {
    const [full, langSuffix, body] = match;
    const start = match.index;
    if (start === undefined) continue;
    const end = start + full.length + (markdown[start + full.length] === "\n" ? 1 : 0);

    const result = parseBlobBlock(`${BLOB_LANG_PREFIX}${langSuffix}`, body);
    if (!result.ok) continue;
    locations.push({ blob: result.value, start, end });
  }
  return locations;
}

/**
 * Apply a shallow payload patch to the blob with `blobId`, rewriting only
 * that fenced block. This is the concurrent-safety primitive: ID-addressed,
 * not offset-addressed, so it stays correct after unrelated edits.
 */
export function patchBlobInMarkdown(
  markdown: string,
  blobId: string,
  patch: Record<string, unknown>,
): BlobResult<string, BlobPatchError> {
  const locations = findBlobs(markdown);
  const location = locations.find((loc) => loc.blob.envelope.id === blobId);
  if (!location) {
    return { ok: false, error: new BlobPatchError("not_found", blobId) };
  }

  // Re-parse just this block's body as a mutable yaml Document so untouched
  // keys, order, and comments survive — the whole reason this isn't a
  // load/patch/dump cycle over the parsed JS object.
  const doc = parseDocument(location.blob.rawYaml);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      error: new BlobPatchError(
        "conflict",
        blobId,
        "block no longer parses as valid YAML",
      ),
    };
  }

  for (const [key, value] of Object.entries(patch)) {
    doc.set(key, value);
  }

  const patchedPayload = (doc.toJS() ?? {}) as Record<string, unknown>;
  const validated = BlobEnvelopeSchema.safeParse(patchedPayload);
  if (!validated.success) {
    return {
      ok: false,
      error: new BlobPatchError(
        "invalid_patch",
        blobId,
        validated.error.message,
      ),
    };
  }

  const newBody = doc.toString().trimEnd();
  const newFence = `\`\`\`${BLOB_LANG_PREFIX}${location.blob.type}\n${newBody}\n\`\`\``;

  // Splice only the fence's own span (start..end, per BlobLocation's exact
  // offsets) — everything outside it, including the trailing newline (or
  // its absence) past the closing fence, is preserved byte-for-byte.
  const before = markdown.slice(0, location.start);
  const after = markdown.slice(location.end);
  const trailingNewline = markdown
    .slice(location.start, location.end)
    .endsWith("\n")
    ? "\n"
    : "";
  const spliced = before + newFence + trailingNewline + after;

  return { ok: true, value: spliced };
}
