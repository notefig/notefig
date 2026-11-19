/**
 * Who else syncs the branch (MET-293), read in the engine's poll with no
 * channel of its own. Each device owns
 * `refs/notefig/v1/presence/<branch>/<deviceId>`: a commit on the branch tip
 * whose message names its user and where its caret is, replaced every
 * `HEARTBEAT_MS` (and when the caret moves) and deleted when the workspace
 * closes. Replaced, never stacked: it takes no history.
 *
 * Liveness is what this client observes: a device is live while its ref
 * moved within `PRESENCE_STALE_MS` by the local clock, so no clock but ours
 * counts. A ref already there on the first poll may be a crash's leftover:
 * it counts once it moves. Seeing a new device republishes at once, so two
 * devices that meet both find out within a poll or two.
 */
import { GitError, type GitRemote, type GitRemoteRef, type GitService } from "@notefig/git";
import type { SyncAuthor } from "./sync-engine";
import type { SyncCursor, SyncEvent, SyncPeer, SyncState } from "./sync-machine";

/** Where the devices syncing `branch` keep their presence. */
export const presencePrefix = (branch: string) => `refs/notefig/v1/presence/${branch}/`;
/** A device's ref moves at least this often. */
export const HEARTBEAT_MS = 30_000;
/** Standing still this long, by this client's clock: gone. */
export const PRESENCE_STALE_MS = 75_000;

export interface PresenceDeps {
  deviceId: string;
  author: SyncAuthor;
  git: GitService;
  remote: GitRemote;
  branch: string;
  now(): number;
  state(): SyncState;
  dispatch(event: SyncEvent): void;
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
  /** Delete this device's ref, so the others see it go at once. */
  leave(): Promise<void>;
}

interface Seen {
  oid: string;
  /** When this client saw it move; null: there on the first poll. */
  movedAt: number | null;
  /** The commit `name` and `cursor` were read from. */
  read: string | null;
  name: string | null;
  cursor: SyncCursor | null;
}

/** What a presence commit's message holds. */
interface Payload {
  name?: unknown;
  cursor?: SyncCursor | null;
}

const COLOURS = ["#2f7ed8", "#c0562f", "#2f9e6e", "#9256c9", "#c79a2c", "#c24580"];

/** A device's colour, the same wherever it's seen. */
export function colourOf(deviceId: string): string {
  let hash = 0;
  for (const char of deviceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

/** A host's lasting answer to this device's ref. */
const REFUSALS = new Set(["PushRejected", "AuthFailed", "AuthRequired"]);

export function createPresence(deps: PresenceDeps): Presence {
  const { git, remote, now } = deps;
  const prefix = presencePrefix(deps.branch);
  const own = `${prefix}${deps.deviceId}`;
  const seen = new Map<string, Seen>();
  let first = true;
  let published = false;
  let nextBeatAt = 0;
  /** Two commits of one tree, parent and second share an oid: this keeps a
   *  republish from leaving the ref where it was. */
  let beat = 0;
  /** The host won't take this device's ref: this session stays solo. */
  let refused = false;
  let cursor: SyncCursor | null = null;

  /** What a device's ref's commit says. */
  const payloadIn = async (oid: string): Promise<Payload> => {
    const [tip] = await git.log({ ref: oid, depth: 1 });
    return (JSON.parse(tip?.commit.message ?? "null") as Payload | null) ?? {};
  };

  /** Note when each ref moved; true when a device came since the last poll. */
  const stamp = (present: Map<string, string>, at: number): boolean => {
    for (const ref of seen.keys()) if (!present.has(ref)) seen.delete(ref);
    let arrived = false;
    for (const [ref, oid] of present) {
      const entry = seen.get(ref);
      if (entry?.oid === oid) continue;
      arrived ||= !entry && !first;
      seen.set(ref, { read: null, name: null, cursor: null, ...entry, oid, movedAt: first ? null : at });
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
          .map(([ref, { name, cursor }]) => {
            const deviceId = ref.slice(prefix.length);
            return { deviceId, name, colour: colourOf(deviceId), cursor };
          })
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
        const fetched = await git.fetchRefs(remote, moved.map(([ref]) => ref));
        for (const { ref, oid } of fetched) {
          const entry = seen.get(ref);
          if (!entry || !oid) continue;
          const payload = await payloadIn(oid);
          Object.assign(entry, {
            read: oid,
            name: typeof payload.name === "string" ? payload.name : null,
            cursor: payload.cursor ?? null,
          });
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
      if (refused || now() < nextBeatAt) return;
      const [tip] = await git.log({ ref: `refs/heads/${deps.branch}`, depth: 1 }).catch(() => []);
      if (!tip) return;
      const oid = await git.commit({
        message: JSON.stringify({ name: deps.author.name, beat: ++beat, cursor }),
        author: deps.author,
        tree: tip.commit.tree,
        parent: [tip.oid],
        noUpdateBranch: true,
      });
      try {
        await git.pushRef(remote, { ref: own, oid, force: true });
        published = true;
        nextBeatAt = now() + HEARTBEAT_MS;
      } catch (error) {
        // The host turned the ref down (a hook, a token for branches only):
        // never again this session. Anything else, the next cycle retries.
        if (!(error instanceof GitError && REFUSALS.has(error.code))) return;
        refused = true;
        announce();
        console.warn("[sync] The remote refused this device's presence ref; syncing solo.", error);
      }
    },

    async leave() {
      if (!published) return;
      published = false;
      try {
        await git.pushRef(remote, { ref: own, delete: true, force: true });
      } catch {
        // Gone or closed: it goes stale on the others' clocks instead.
      }
    },
  };
}
