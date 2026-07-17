import type { BlobTypeDefinition } from "./blob-type";

export type { BlobWidgetProps, BlobTypeDefinition } from "./blob-type";
export { defineBlobType } from "./blob-type";

/**
 * One-file blob type protocol: a new blob type is a single `<name>.blob.tsx`
 * file in this directory that default-exports `defineBlobType({...})`
 * (imported from `./blob-type`, not from here — see that file's docstring
 * for why). The glob below picks it up; no central list to edit.
 */
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
