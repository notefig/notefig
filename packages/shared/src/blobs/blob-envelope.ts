import { z } from "zod";

/** Language-tag prefix that marks a fenced code block as a deferred blob. */
export const BLOB_LANG_PREFIX = "metrists:";

export const BlobStatusSchema = z.enum([
  "pending",
  "answered",
  "dismissed",
  "superseded",
]);
export type BlobStatus = z.infer<typeof BlobStatusSchema>;

/**
 * Canonical envelope every blob payload must satisfy, regardless of type.
 * `.passthrough()` is load-bearing: unknown keys written by an agent (or a
 * newer Metrists) must survive parse → patch → serialize untouched.
 */
export const BlobEnvelopeSchema = z
  .object({
    /** e.g. "q_8f2a" — short prefix + lowercase alphanumeric suffix */
    id: z.string().regex(/^[a-z]+_[a-z0-9]{4,}$/),
    status: BlobStatusSchema.default("pending"),
    createdBy: z.enum(["agent", "user"]).default("agent"),
    answeredAt: z.string().datetime().optional(),
  })
  .passthrough();

export type BlobEnvelope = z.infer<typeof BlobEnvelopeSchema>;

/** A blob parsed out of markdown, before type-specific schema validation. */
export type ParsedBlob = {
  /** The `<type>` part of the `metrists:<type>` language tag */
  type: string;
  envelope: BlobEnvelope;
  /** Full YAML payload including unknown keys, as parsed */
  payload: Record<string, unknown>;
  /** The exact fence body text, for byte-identical fallback rendering */
  rawYaml: string;
};

/** Location of a blob's fenced block within a markdown string. */
export type BlobLocation = {
  blob: ParsedBlob;
  /** Offset of the opening fence's first backtick */
  start: number;
  /** Offset just past the closing fence (and its trailing newline, if any) */
  end: number;
};
