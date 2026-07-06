import type { ComponentType } from "react";
import type { z } from "zod";
import type { ParsedBlob } from "@metrists/shared/blobs";

/**
 * One-file blob type protocol (DX convention shared with drag-protocol):
 * a new blob type is a single `<name>.blob.tsx` file in this directory that
 * default-exports defineBlobType({...}). The glob below picks it up; no
 * central list to edit.
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

const modules = import.meta.glob<{ default: BlobTypeDefinition }>(
  "./*.blob.tsx",
  { eager: true },
);

const registry = new Map<string, BlobTypeDefinition>(
  Object.values(modules).map((module) => [module.default.type, module.default]),
);

export function getBlobType(type: string): BlobTypeDefinition | undefined {
  return registry.get(type);
}

export function getAllBlobTypes(): BlobTypeDefinition[] {
  return [...registry.values()];
}
