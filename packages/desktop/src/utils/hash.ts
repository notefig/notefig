/**
 * Content hashing for file modification tracking. Uses MD5 for deterministic
 * cross-platform hashing that matches the Rust file-watcher implementation.
 */

import md5 from "md5";

export function calculateContentHash(content: string): string {
  // Hash bytes, not the string: md5's string path UTF-8-encodes via
  // encodeURIComponent, which throws URIError on lone surrogates — making
  // every save of such a document fail. TextEncoder replaces lone
  // surrogates with U+FFFD, which is exactly what Rust reads back after
  // the lossy disk write, so JS and Rust digests stay in agreement.
  return md5(new TextEncoder().encode(content));
}

export function hashesEqual(
  hash1: string | undefined,
  hash2: string | undefined,
): boolean {
  return hash1 === hash2;
}

export function isContentModified(
  currentContent: string,
  savedContentHash: string | undefined,
): boolean {
  if (!savedContentHash) return true; // No saved hash means it's new/modified
  const currentHash = calculateContentHash(currentContent);
  return currentHash !== savedContentHash;
}
