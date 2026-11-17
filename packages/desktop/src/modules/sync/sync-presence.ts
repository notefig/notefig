/**
 * Who else syncs the branch (MET-293), read in the engine's poll with no
 * channel of its own. Each device owns
 * `refs/notefig/v1/presence/<branch>/<deviceId>`: a commit on the branch tip
 * whose message names its user, replaced every `HEARTBEAT_MS` and deleted
 * when the workspace closes. Replaced, never stacked: it takes no history.
 *
 * Liveness is what this client observes: a device is live while its ref
 * moved within `PRESENCE_STALE_MS` by the local clock, so no clock but ours
 * counts. A ref already there on the first poll may be a crash's leftover:
 * it counts once it moves. Seeing a new device republishes at once, so two
 * devices that meet both find out within a poll or two.
 */
import { GitError, type GitRemote, type GitRemoteRef, type GitService } from "@notefig/git";
import type { SyncAuthor } from "./sync-engine";
import type { SyncEvent, SyncPeer, SyncState } from "./sync-machine";

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
  observe(refs: GitRemoteRef[]): Promise<void>;
  /** Replace this device's ref when a heartbeat is due, or someone new
   *  needs to see it. */
  heartbeat(): Promise<void>;
  /** Delete this device's ref, so the others see it go at once. */
  leave(): Promise<void>;
}

interface Seen {
  oid: string;
  /** When this client saw it move; null: there on the first poll. */
  movedAt: number | null;
  name: string | null;
}

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
  /** The host won't take the ref: this session stays solo. */
  let refused = false;

  /** A device's user, read once from its ref's commit. */
  const nameOf = async (ref: string): Promise<string | null> => {
    try {
      const [fetched] = await git.fetchRefs(remote, [ref]);
      const [tip] = fetched?.oid ? await git.log({ ref: fetched.oid, depth: 1 }) : [];
      const name = (JSON.parse(tip?.commit.message ?? "null") as { name?: unknown } | null)?.name;
      return typeof name === "string" ? name : null;
    } catch {
      return null;
    }
  };

  /** Note when each ref moved; true when a device came since the last poll. */
  const stamp = (present: Map<string, string>, at: number): boolean => {
    for (const ref of seen.keys()) if (!present.has(ref)) seen.delete(ref);
    let arrived = false;
    for (const [ref, oid] of present) {
      const entry = seen.get(ref);
      if (entry?.oid === oid) continue;
      arrived ||= !entry && !first;
      seen.set(ref, { oid, movedAt: first ? null : at, name: entry?.name ?? null });
    }
    first = false;
    return arrived;
  };

  /** The devices whose ref moved lately, by name. */
  const live = async (at: number): Promise<SyncPeer[]> => {
    const peers: SyncPeer[] = [];
    for (const [ref, entry] of seen) {
      if (entry.movedAt === null || at - entry.movedAt >= PRESENCE_STALE_MS) continue;
      entry.name ??= await nameOf(ref);
      if (entry.name) peers.push({ deviceId: ref.slice(prefix.length), name: entry.name });
    }
    return peers.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  };

  return {
    async observe(refs) {
      const at = now();
      const present = refs.filter(({ ref }) => ref.startsWith(prefix) && ref !== own);
      // Someone new: show them this device now, not a heartbeat later.
      if (stamp(new Map(present.map(({ ref, oid }) => [ref, oid])), at)) nextBeatAt = 0;
      const peers = await live(at);
      if (JSON.stringify(peers) !== JSON.stringify(deps.state().peers)) deps.dispatch({ type: "peers", peers });
    },

    async heartbeat() {
      if (refused || now() < nextBeatAt) return;
      const [tip] = await git.log({ ref: `refs/heads/${deps.branch}`, depth: 1 }).catch(() => []);
      if (!tip) return;
      const oid = await git.commit({
        message: JSON.stringify({ name: deps.author.name, beat: ++beat }),
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
        // Unreachable: the next cycle tries again. Refused: never again.
        if (!(error instanceof GitError) || error.code === "Network") return;
        refused = true;
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
