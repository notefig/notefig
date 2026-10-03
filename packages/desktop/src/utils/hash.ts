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
