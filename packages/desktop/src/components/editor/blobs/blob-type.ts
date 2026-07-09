import type { ComponentType } from "react";
import type { z } from "zod";
import type { ParsedBlob } from "@metrists/shared/blobs";

/**
 * One-file blob type protocol (DX convention shared with drag-protocol):
 * a new blob type is a single `<name>.blob.tsx` file in this directory that
 * default-exports defineBlobType({...}). `blob-registry.ts` globs those
 * files eagerly, so this leaf module (types + the `defineBlobType` identity
 * helper) has to stay dependency-free of the registry itself — a `.blob.tsx`
 * importing `defineBlobType` back from `blob-registry.ts` would be a real
 * import cycle (registry glob-imports the file, the file imports the
 * registry), which breaks under strict ESM evaluation order.
 */

export type BlobWidgetProps<Payload> = {
  blob: ParsedBlob;
  payload: Payload;
  /** Patch the blob's YAML in the file (ID-addressed; see blob-actions). */
  answer: (patch: Record<string, unknown>) => Promise<void>;
};

export type BlobTypeDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> = {
  /** The `<type>` part of the metrists:<type> language tag */
  type: string;
  /** Type-specific payload schema, validated on top of the shared envelope */
  schema: Schema;
  Widget: ComponentType<BlobWidgetProps<z.infer<Schema>>>;
  /** Fold a widget answer into the patch written back to the file */
  onAnswer: (
    blob: ParsedBlob,
    patch: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Plain-text fallback for exports and non-interactive rendering */
  summaryText: (payload: z.infer<Schema>) => string;
};

export function defineBlobType<Schema extends z.ZodTypeAny>(
  definition: BlobTypeDefinition<Schema>,
): BlobTypeDefinition<Schema> {
  return definition;
}
