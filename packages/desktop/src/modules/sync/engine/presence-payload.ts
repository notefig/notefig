/**
 * The presence ref's payload (MET-272, decision 7): one JSON blob per
 * device at `refs/notefig/v1/presence/<deviceId>`, replaced on every
 * update, so it never grows history. Hosts accept a ref that points
 * straight at a blob.
 *
 * Read defensively: a payload is another device's (or anyone's) bytes, so
 * anything malformed is dropped rather than trusted. Nothing in it says
 * when it was written — liveness is the reader's own observation of the
 * ref moving (`presence-liveness.ts`); `seq` exists only so a heartbeat
 * with nothing new still moves the ref.
 */
import type { SyncBlockPosition } from "../document-channel";
import { PRESENCE_COLOR_PATTERN } from "../presence-identity";
import type {
  SyncPresenceAgent,
  SyncPresenceCursor,
  SyncPresencePayload,
} from "../sync-types";

/** The payload format; bumped together with the ref namespace's `v1`. */
export const PRESENCE_FORMAT_VERSION = 1;
export const PRESENCE_REF_PREFIX = "refs/notefig/v1/presence/";
/** Bounds on what a payload may carry, so a bad one can't flood a reader. */
const MAX_CURSORS = 16;
const MAX_AGENTS = 16;
const MAX_TEXT = 200;

export const presenceRef = (deviceId: string) => `${PRESENCE_REF_PREFIX}${deviceId}`;

/** The device a presence ref belongs to; null for any other ref. */
export function presenceDeviceOf(ref: string): string | null {
  if (!ref.startsWith(PRESENCE_REF_PREFIX)) return null;
  const id = ref.slice(PRESENCE_REF_PREFIX.length);
  return id.length > 0 && !id.includes("/") ? id : null;
}

export function encodePresence(payload: SyncPresencePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

function position(value: unknown): SyncBlockPosition | null {
  if (!isObject(value)) return null;
  const blockIndex = count(value.blockIndex);
  const offset = count(value.offset);
  return blockIndex === null || offset === null ? null : { blockIndex, offset };
}

function cursor(value: unknown): SyncPresenceCursor | null {
  if (!isObject(value)) return null;
  const path = text(value.path);
  const anchor = position(value.anchor);
  if (!path || !anchor) return null;
  const head = position(value.head);
  return head ? { path, anchor, head } : { path, anchor };
}

function agent(value: unknown): SyncPresenceAgent | null {
  if (!isObject(value)) return null;
  const taskId = text(value.taskId);
  const harness = text(value.harness);
  if (!taskId || !harness) return null;
  const status = value.status === "editing" ? "editing" : "working";
  const path = text(value.path);
  const anchor = path ? position(value.anchor) : null;
  return {
    taskId,
    harness,
    label: text(value.label) ?? harness,
    status,
    ...(path ? { path } : {}),
    ...(anchor ? { anchor } : {}),
  };
}


function list<T>(value: unknown, read: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map(read)
    .filter((item): item is T => item !== null);
}

/** A presence blob's payload; null when it isn't one this version reads. */
export function decodePresence(bytes: Uint8Array): SyncPresencePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== PRESENCE_FORMAT_VERSION) return null;
  const deviceId = text(raw.deviceId);
  const user = isObject(raw.user) ? raw.user : null;
  const name = user ? text(user.name) : null;
  const color = user && typeof user.color === "string" && PRESENCE_COLOR_PATTERN.test(user.color) ? user.color : null;
  if (!deviceId || !name || !color) return null;
  return {
    v: PRESENCE_FORMAT_VERSION,
    user: { name, color },
    deviceId,
    commit: typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null,
    seq: count(raw.seq) ?? 0,
    focused: raw.focused === true,
    cursors: list(raw.cursors, cursor, MAX_CURSORS),
    agents: list(raw.agents, agent, MAX_AGENTS),
  };
}

/** A payload with the parts that say something (no `seq`, no `commit`):
 *  what "presence changed" compares. */
export function presenceSignature(payload: Omit<SyncPresencePayload, "seq" | "commit">): string {
  return JSON.stringify([payload.user, payload.focused, payload.cursors, payload.agents]);
}
