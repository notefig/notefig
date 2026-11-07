/**
 * The lease ref and its payload (MET-273, decision 6): one ref per holder
 * per document, `refs/notefig/v1/locks/<docId>/<holder>`, pointing at a
 * JSON blob that lists the blocks it holds as indexes relative to
 * `commit`. Clients map those indexes onto their own head with the merge's
 * block alignment, so a lease follows its block through other people's
 * edits. Every update replaces the blob: no history growth.
 *
 * `docId` is `sha1(path)`; `<holder>` is the holder id made ref-safe (an
 * agent's id is `<deviceId>/<taskId>`, and a ref can't be both a file and a
 * folder). Both are checked against the payload when it is read.
 *
 * Read defensively: anything malformed is dropped. Nothing in the payload
 * says when it was written; staleness is the reader's own observation of
 * the ref moving (`seq` exists so a renewal moves it).
 */
import type { LeaseHolder } from "../lease-rules";
import { PRESENCE_COLOR_PATTERN } from "../presence-identity";
import type { SyncLeasePayload } from "../sync-types";

export const LEASE_FORMAT_VERSION = 1;
export const LOCK_REF_PREFIX = "refs/notefig/v1/locks/";
/** Bounds on what a payload may carry. */
const MAX_BLOCKS = 200;
const MAX_TEXT = 200;
const MAX_PATH = 1_024;

/** A holder id as one ref path component: `[A-Za-z0-9_-]` kept, anything
 *  else `.` + its hex code. */
export function holderSegment(holderId: string): string {
  return holderId.replace(/[^A-Za-z0-9_-]/g, (c) => `.${c.charCodeAt(0).toString(16)}`);
}

export const lockRef = (docId: string, holderId: string) =>
  `${LOCK_REF_PREFIX}${docId}/${holderSegment(holderId)}`;

/** The document and holder parts of a lock ref; null for any other ref. */
export function parseLockRef(ref: string): { docId: string; segment: string } | null {
  if (!ref.startsWith(LOCK_REF_PREFIX)) return null;
  const parts = ref.slice(LOCK_REF_PREFIX.length).split("/");
  if (parts.length !== 2 || !/^[0-9a-f]{40}$/.test(parts[0]) || !parts[1]) return null;
  return { docId: parts[0], segment: parts[1] };
}

/** `sha1(path)` in hex: the document's id in lock refs. */
export async function docIdOf(path: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeLease(payload: SyncLeasePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max = MAX_TEXT): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

const colorOf = (value: unknown) =>
  typeof value === "string" && PRESENCE_COLOR_PATTERN.test(value) ? value : null;

const kindOf = (value: unknown): LeaseHolder["kind"] | null =>
  value === "agent" || value === "human" ? value : null;

/** An agent's id is `<deviceId>/<taskId>`, a person's their device id. */
function idMatches(holder: { id: string; kind: string; deviceId: string; taskId: string | null }) {
  if (holder.kind === "human") return holder.id === holder.deviceId;
  return holder.taskId !== null && holder.id === `${holder.deviceId}/${holder.taskId}`;
}

function holderOf(value: unknown): LeaseHolder | null {
  if (!isObject(value)) return null;
  const fields = {
    id: text(value.id),
    deviceId: text(value.deviceId),
    name: text(value.name),
    color: colorOf(value.color),
    kind: kindOf(value.kind),
  };
  const { id, deviceId, name, color, kind } = fields;
  if (!id || !deviceId || !name || !color || !kind) return null;
  const taskId = text(value.taskId);
  if (!idMatches({ id, kind, deviceId, taskId })) return null;
  const harness = text(value.harness);
  const agent = kind === "agent" ? { taskId: taskId!, ...(harness ? { harness } : {}) } : {};
  return { id, kind, deviceId, name, color, ...agent };
}

function blocksOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return null;
  const out = value.filter((item): item is number => Number.isInteger(item) && item >= 0);
  return out.length === value.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/**
 * A lease blob's payload, checked against the ref it was read from (its
 * document id and holder segment); null when it isn't one this version
 * reads.
 */
export async function decodeLease(bytes: Uint8Array, ref: string): Promise<SyncLeasePayload | null> {
  const parsedRef = parseLockRef(ref);
  if (!parsedRef) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== LEASE_FORMAT_VERSION) return null;
  const holder = holderOf(raw.holder);
  const path = text(raw.path, MAX_PATH);
  const blocks = blocksOf(raw.blocks);
  const commit = typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null;
  if (!holder || !path || !blocks || !commit) return null;
  if (holderSegment(holder.id) !== parsedRef.segment) return null;
  if ((await docIdOf(path)) !== parsedRef.docId) return null;
  const seq = Number.isInteger(raw.seq) && (raw.seq as number) >= 0 ? (raw.seq as number) : 0;
  return { v: LEASE_FORMAT_VERSION, holder, path, commit, seq, blocks };
}
