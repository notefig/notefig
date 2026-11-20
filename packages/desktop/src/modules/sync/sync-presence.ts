/**
 * Who else syncs the branch (MET-293), read in the engine's poll with no
 * channel of its own. Each device owns
 * `refs/notefig/v1/presence/<branch>/<deviceId>`: a commit on the branch tip
 * whose message names its user, its colour, where its caret is and the
 * units it's editing (`sync-claims.ts`; all of it in that one commit,
 * checked before it's shown), replaced every `HEARTBEAT_MS` (and when the
 * caret moves or a claim changes) and deleted when the workspace closes or
 * the app quits. Replaced, never stacked: it takes no history.
 *
 * Liveness is what this client observes: a device is live while its ref
 * moved within `PRESENCE_STALE_MS` by the local clock, so no clock but ours
 * counts. A ref already there on the first poll may be a crash's leftover:
 * it counts once it moves. Seeing a new device republishes at once, so two
 * devices that meet both find out within a poll or two.
 *
 * What it leaves behind stays bounded (MET-274): a ref that stood still
 * `SWEEP_STALE_MS` is deleted by whoever sees it, only if it's still where
 * they saw it; this device's replaced commits, and the packs fetched to read
 * the others', are dropped locally.
 */
import { GitError, type GitRemote, type GitRemoteRef, type GitService } from "@notefig/git";
import type { SyncAuthor } from "./sync-engine";
import { MAX_CLAIM_KEYS } from "./sync-claims";
import type { SyncClaim, SyncCursor, SyncEvent, SyncPeer, SyncState } from "./sync-machine";

/** Where the devices syncing `branch` keep their presence. */
export const presencePrefix = (branch: string) => `refs/notefig/v1/presence/${branch}/`;
/** A device's ref moves at least this often. */
export const HEARTBEAT_MS = 30_000;
/** Standing still this long, by this client's clock: gone. */
export const PRESENCE_STALE_MS = 75_000;
/** Standing still this long: a device that never said goodbye (a crash, a
 *  quit offline). Its ref is swept. */
export const SWEEP_STALE_MS = 10 * 60_000;
/** At most one sweep a minute, of one ref and of what's local. */
const SWEEP_EVERY_MS = 60_000;

export interface PresenceDeps {
  deviceId: string;
  author: SyncAuthor;
  git: GitService;
  remote: GitRemote;
  branch: string;
  now(): number;
  state(): SyncState;
  dispatch(event: SyncEvent): void;
  /** What this device is editing, for each heartbeat. */
  claims(): SyncClaim[];
}

export interface Presence {
  /** One poll's refs: note what moved, and announce who's here. */
  observe(refs: GitRemoteRef[]): void;
  /** Read who moved, and where their caret is now, in one fetch: after the
   *  cycle's branch work, which never waits on it. */
  read(): Promise<void>;
  /** Replace this device's ref when a heartbeat is due, someone new needs
   *  to see it, or its caret moved. */
  heartbeat(): Promise<void>;
  /** Where this device's caret is, for the next heartbeat. */
  setCursor(cursor: SyncCursor | null): void;
  /** Delete one ref left standing, and what this device no longer reads. */
  sweep(): Promise<void>;
  /** Delete this device's ref, so the others see it go at once. */
  leave(): Promise<void>;
}

interface Seen {
  oid: string;
  /** When this client first saw it at `oid`. */
  since: number;
  /** When this client saw it move; null: there on the first poll. */
  movedAt: number | null;
  /** The commit the rest was read from. */
  read: string | null;
  name: string | null;
  colour: string | null;
  cursor: SyncCursor | null;
  claims: SyncClaim[];
}

const COLOURS = ["#2f7ed8", "#c0562f", "#2f9e6e", "#9256c9", "#c79a2c", "#c24580"];

/** The colour a device picks for itself, and sends in its heartbeat. */
function colourOf(deviceId: string): string {
  let hash = 0;
  for (const char of deviceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** More than any build sends: a device holds four units, by a few keys. */
const MAX_READ_CLAIMS = 16;
const MAX_READ_KEYS = MAX_CLAIM_KEYS;
/** Its text's hash, the ones before and after it, and which repeat it is
 *  (`sync-units.ts`). */
const KEY = /^[0-9a-z]{1,8}\.[0-9a-z]{1,8}\.[0-9a-z]{1,8}\.\d{1,5}$/;

/** The well-formed claims among what a commit says. */
function claimsOf(raw: unknown): SyncClaim[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_READ_CLAIMS).flatMap((claim: unknown) => {
    const { path, keys, agent } = (claim ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || !Array.isArray(keys)) return [];
    const valid = keys.slice(0, MAX_READ_KEYS).filter((key): key is string => typeof key === "string" && KEY.test(key));
    return valid.length > 0 ? [{ path, keys: valid, agent: agent === true }] : [];
  });
}

/** What another device's commit says, keeping only what's well formed:
 *  anyone who can push to the remote can write it. */
function payloadOf(message: string): Pick<Seen, "name" | "colour" | "cursor" | "claims"> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Not ours: nothing to show.
  }
  const cursor = (raw.cursor ?? null) as Record<string, unknown> | null;
  return {
    name: typeof raw.name === "string" ? raw.name : null,
    colour: typeof raw.colour === "string" && /^#[0-9a-f]{6}$/i.test(raw.colour) ? raw.colour : null,
    cursor:
      cursor && typeof cursor.path === "string" && count(cursor.unit) && count(cursor.offset)
        ? { path: cursor.path, unit: cursor.unit, offset: cursor.offset }
        : null,
    claims: claimsOf(raw.claims),
  };
}

/** A host's lasting answer to this device's ref. */
const REFUSALS = new Set(["PushRejected", "AuthFailed", "AuthRequired"]);

export function createPresence(deps: PresenceDeps): Presence {
  const { git, remote, now } = deps;
  const prefix = presencePrefix(deps.branch);
  const own = `${prefix}${deps.deviceId}`;
  const seen = new Map<string, Seen>();
  let first = true;
  let published: string | null = null;
  /** This device's commits a heartbeat replaced: nothing reads them. */
  let replaced: string[] = [];
  let nextSweepAt = 0;
  let nextBeatAt = 0;
  /** Two commits of one tree, parent and second share an oid: this keeps a
   *  republish from leaving the ref where it was. */
  let beat = 0;
  /** The host won't take this device's ref: this session stays solo. */
  let refused = false;
  let cursor: SyncCursor | null = null;
  /** The claims the last heartbeat sent. */
  let sentClaims = "[]";

  /** What a device's ref's commit says. */
  const payloadIn = async (oid: string) => payloadOf((await git.log({ ref: oid, depth: 1 }))[0]?.commit.message ?? "");

  /** Note when each ref moved; true when a device came since the last poll. */
  const stamp = (present: Map<string, string>, at: number): boolean => {
    for (const ref of seen.keys()) if (!present.has(ref)) seen.delete(ref);
    let arrived = false;
    for (const [ref, oid] of present) {
      const entry = seen.get(ref);
      if (entry?.oid === oid) continue;
      arrived ||= !entry && !first;
      seen.set(ref, { read: null, name: null, colour: null, cursor: null, claims: [], ...entry, oid, since: at, movedAt: first ? null : at });
    }
    first = false;
    return arrived;
  };

  /** The refs of the devices whose ref moved lately. */
  const live = (at: number) =>
    [...seen].filter(([, entry]) => entry.movedAt !== null && at - entry.movedAt < PRESENCE_STALE_MS);

  /** Announce who's here, unless this device can't be seen itself. */
  const announce = () => {
    const peers: SyncPeer[] = refused
      ? []
      : live(now())
          .map(([ref, { name, colour, cursor, claims }]) => ({ deviceId: ref.slice(prefix.length), name, colour, cursor, claims }))
          .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    if (JSON.stringify(peers) !== JSON.stringify(deps.state().peers)) deps.dispatch({ type: "peers", peers });
  };

  return {
    observe(refs) {
      const present = refs.filter(({ ref }) => ref.startsWith(prefix) && ref !== own);
      // Someone new: show them this device now, not a heartbeat later.
      if (stamp(new Map(present.map(({ ref, oid }) => [ref, oid])), now())) nextBeatAt = 0;
      announce();
    },

    async read() {
      const moved = live(now()).filter(([, entry]) => entry.read !== entry.oid);
      if (refused || moved.length === 0) return;
      try {
        const fetched = await git.fetchRefs(remote, moved.map(([ref]) => ref), { transient: true });
        for (const { ref, oid } of fetched) {
          const entry = seen.get(ref);
          if (!entry || !oid) continue;
          Object.assign(entry, { read: oid, ...(await payloadIn(oid)) });
        }
      } catch {
        // What's unread waits for the next cycle; the devices count already.
      }
      announce();
    },

    setCursor(next) {
      if (JSON.stringify(next) === JSON.stringify(cursor)) return;
      cursor = next;
      nextBeatAt = 0;
    },

    async heartbeat() {
      // A claim goes out at once: it's what keeps others' edits off the unit.
      const claims = deps.claims();
      const claimed = JSON.stringify(claims);
      if (refused || (now() < nextBeatAt && claimed === sentClaims)) return;
      const [tip] = await git.log({ ref: `refs/heads/${deps.branch}`, depth: 1 }).catch(() => []);
      if (!tip) return;
      // A caret that moves while this goes out is sent by the next cycle.
      const sent = cursor;
      const oid = await git.commit({
        message: JSON.stringify({ name: deps.author.name, colour: colourOf(deps.deviceId), beat: ++beat, cursor: sent, claims }),
        author: deps.author,
        tree: tip.commit.tree,
        parent: [tip.oid],
        noUpdateBranch: true,
      });
      try {
        await git.pushRef(remote, { ref: own, oid, force: true });
        if (published) replaced.push(published);
        published = oid;
        sentClaims = claimed;
        nextBeatAt = sent === cursor ? now() + HEARTBEAT_MS : 0;
      } catch (error) {
        // The host turned the ref down (a hook, a token for branches only):
        // never again this session. Anything else, the next cycle retries.
        if (!(error instanceof GitError && REFUSALS.has(error.code))) return;
        refused = true;
        announce();
        console.warn("[sync] The remote refused this device's presence ref; syncing solo.", error);
      }
    },

    async sweep() {
      const at = now();
      if (refused || at < nextSweepAt) return;
      nextSweepAt = at + SWEEP_EVERY_MS;
      const [stalest] = [...seen]
        .filter(([, entry]) => at - entry.since >= SWEEP_STALE_MS)
        .sort(([, a], [, b]) => a.since - b.since);
      if (stalest) {
        const [ref, { oid }] = stalest;
        // Moved since, or another device swept it first: the next poll
        // shows which. Unreachable: tried again in a minute.
        await git.pushRef(remote, { ref, delete: true, force: true, expect: oid }).catch(() => {});
      }
      const oids = replaced;
      replaced = [];
      // A presence read finishes in its cycle; ten minutes is ample.
      await git.sweepTransient({ olderThanMs: SWEEP_STALE_MS, oids }).catch(() => {});
    },

    async leave() {
      if (!published) return;
      published = null;
      try {
        await git.pushRef(remote, { ref: own, delete: true, force: true });
      } catch {
        // Gone or closed: it goes stale on the others' clocks instead.
      }
    },
  };
}
