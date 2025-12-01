/**
 * Hash-based file modification tracking utilities
 *
 * This system uses content hashing to reliably detect when files have been modified
 * from their last saved state. When files are loaded or saved, we calculate and store
 * a hash of the content. The UI can then compare current content hash vs saved hash
 * to determine modification status.
 *
 * Benefits:
 * - Reliable change detection regardless of content
 * - Fast comparison using short hash strings
 * - Consistent across file tree and editor UI
 * - Handles edge cases like whitespace/formatting changes
 */

/**
 * Calculates a simple hash of a string content
 * Uses a fast djb2 hash algorithm suitable for detecting content changes
 */
export function calculateContentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i);
  }
  return (hash >>> 0).toString(36); // Convert to base36 for shorter string
}

/**
 * Compares two content hashes for equality
 */
export function hashesEqual(
  hash1: string | undefined,
  hash2: string | undefined,
): boolean {
  return hash1 === hash2;
}

/**
 * Checks if content has been modified by comparing hashes
 */
export function isContentModified(
  currentContent: string,
  savedContentHash: string | undefined,
): boolean {
  if (!savedContentHash) return true; // No saved hash means it's new/modified
  return calculateContentHash(currentContent) !== savedContentHash;
}
