/**
 * Hash-based file modification tracking utilities
 *
 * This system uses content hashing to reliably detect when files have been modified
 * from their last saved state. When files are loaded or saved, we calculate and store
 * a hash of the content. The UI can then compare current content hash vs saved hash
 * to determine modification status.
 *
 * Uses MD5 for deterministic cross-platform hashing (matches Rust implementation)
 *
 * Benefits:
 * - Reliable change detection regardless of content
 * - Fast comparison using short hash strings
 * - Consistent across file tree and editor UI
 * - Handles edge cases like whitespace/formatting changes
 * - Matches Rust hashing for file watcher integration
 */

import md5 from "md5";

/**
 * Calculates an MD5 hash of string content
 * This matches the Rust implementation for consistent cross-platform hashing
 */
export function calculateContentHash(content: string): string {
  return md5(content);
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
  const currentHash = calculateContentHash(currentContent);
  return currentHash !== savedContentHash;
}
