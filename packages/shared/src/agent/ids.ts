/**
 * Prefixed, time-sortable identifiers for agent entities (opencode's scheme,
 * see docs/architecture/agent-harness.md "Identity"). Layout:
 *
 *   prefix_ + 16 hex chars (64-bit big-endian: ms-timestamp * 4096 +
 *   per-ms counter) + 10 random base62 chars
 *
 * - ascending ids sort lexicographically in creation order, even within the
 *   same millisecond (12-bit counter), and their timestamp is decodable;
 * - descending ids bitwise-invert the time field so the *newest* sorts
 *   first — used for tasks so any task list is newest-first for free.
 *
 * We deviate from opencode in one way: they pack the time field into 48
 * bits, which silently truncates the top bits of (ms * 4096) and wraps the
 * sort order every ~2.2 years; we use the full 64 bits (16 hex chars) and
 * shorten the random tail to keep the same 26-char body.
 *
 * ACP gives us no message identity (updates are anonymous chunks), so every
 * id here is minted client-side. Blob envelope ids are deliberately a
 * different scheme (short, agent-authored — see blobs/blob-envelope.ts);
 * these ids identify app-side entities only.
 */

const ID_PREFIXES = {
  task: "task",
  turn: "trn",
  message: "msg",
  event: "evt",
  permission: "per",
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

const TIME_HEX_CHARS = 16;
const RANDOM_CHARS = 10;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_64 = (1n << 64n) - 1n;
const COUNTER_BITS = 12n;

let lastTimestamp = 0;
let counter = 0;

// Structural type: shared's tsconfig has no DOM lib, and Node's built-in
// webcrypto satisfies the same shape (Node ≥ 19 and every browser).
type WebCryptoLike = { getRandomValues(array: Uint8Array): Uint8Array };

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  const webCrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let result = "";
  for (let i = 0; i < length; i++) result += BASE62[bytes[i] % 62];
  return result;
}

function createId(
  prefix: IdPrefix,
  direction: "ascending" | "descending",
  timestampMs?: number,
): string {
  const now = timestampMs ?? Date.now();
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter++;

  let time = (BigInt(now) << COUNTER_BITS) + BigInt(counter);
  if (direction === "descending") time = ~time & MASK_64;

  const hex = time.toString(16).padStart(TIME_HEX_CHARS, "0");
  return `${ID_PREFIXES[prefix]}_${hex}${randomBase62(RANDOM_CHARS)}`;
}

/** Descending: newest task sorts first in any lexicographic list. */
export function newTaskId(): string {
  return createId("task", "descending");
}

/** Ascending: chronological within a task. */
export function newTurnId(): string {
  return createId("turn", "ascending");
}

/** Ascending: the addressable transcript unit (see agent-collections). */
export function newMessageId(): string {
  return createId("message", "ascending");
}

/** Ascending: stream/event rows. */
export function newEventId(): string {
  return createId("event", "ascending");
}

export function newPermissionId(): string {
  return createId("permission", "ascending");
}

/**
 * Decode the creation time of an *ascending* id (msg_/evt_/trn_/per_).
 * Returns undefined for malformed input; do not call on descending ids
 * (task_) — the time field is inverted there.
 */
export function idTimestamp(id: string): number | undefined {
  const underscore = id.indexOf("_");
  if (underscore === -1) return undefined;
  const hex = id.slice(underscore + 1, underscore + 1 + TIME_HEX_CHARS);
  if (hex.length !== TIME_HEX_CHARS || !/^[0-9a-f]+$/.test(hex)) {
    return undefined;
  }
  return Number(BigInt(`0x${hex}`) >> COUNTER_BITS);
}
