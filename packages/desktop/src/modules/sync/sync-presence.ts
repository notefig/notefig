/**
 * Presence: who else is on this remote, as refs, inside the engine's poll
 * and with no channel of its own. Each device owns
 * `refs/notefig/v1/presence/<deviceId>`, a commit on the branch tip with
 * the payload (name, cursor, agents) as its message, replaced on each
 * change: it takes no history, and the commit is the only object it costs.
 *
 * Liveness is what this client observes: a peer is live while its ref
 * moved within `PRESENCE_STALE_MS` by the local clock. A ref already there
 * on the first poll may be a crash's leftover, so it counts once it moves;
 * seeing a new device republishes at once, so two devices that meet both
 * find out within a poll or two. Nothing in a payload says when.
 */
import type { Hooks } from "@notefig/core";
import type { GitRemote, GitRemoteRef, GitService } from "@notefig/git";
import { path as pathutil } from "@/utils/path";
import type { SyncCursor, SyncEvent, SyncPeer, SyncState } from "./sync-machine";

export const PRESENCE_PREFIX = "refs/notefig/v1/presence/";
/** A device's ref moves at least this often. */
const HEARTBEAT_MS = 30_000;
/** Standing still this long, by this client's clock: gone. */
export const PRESENCE_STALE_MS = 75_000;

/** A ref that stands still this long is swept (compare-and-swap), plus up
 *  to `SWEEP_JITTER_MS` per client, and at most one per minute. */
export const STALE_DELETE_MS = 10 * 60_000;
const SWEEP_JITTER_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** Packs fetched for a transient ref outlive it by this much: an overlay
 *  of the current WIP may still be reading them. */
const TRANSIENT_OBJECTS_MS = 10 * 60_000;

/** Quiet, legible on both themes. */
const COLORS = ["#2f7ed8", "#c0562f", "#2f9e6e", "#9256c9", "#c79a2c", "#c24580"];

export function colorOf(deviceId: string): string {
  let sum = 0;
  for (const char of deviceId) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[sum % COLORS.length];
}

const ACTIVE = new Set(["pending", "in_progress"]);

export interface PresenceDeps {
  root: string;
  deviceId: string;
  name: string;
  author: { name: string; email: string };
  git: GitService;
  remote: GitRemote;
  branchRef: string;
  hooks: Hooks;
  state(): SyncState;
  dispatch(event: SyncEvent): void;
  now(): number;
  random(): number;
}

interface Seen {
  oid: string;
  /** When this client saw it move; null: dormant, from the first poll. */
  movedAt: number | null;
  peer: SyncPeer | null;
  /** When this client first saw it at this oid. */
  since: number;
  /** This client's own sweep delay, jitter included. */
  sweepAfter: number;
}

function parsePeer(deviceId: string, message: string): SyncPeer | null {
  try {
    const raw = JSON.parse(message) as Partial<SyncPeer>;
    if (typeof raw.name !== "string") return null;
    return { deviceId, name: raw.name, color: colorOf(deviceId), cursor: raw.cursor ?? null, agents: raw.agents ?? [] };
  } catch {
    return null;
  }
}

export function createPresence(deps: PresenceDeps) {
  const { git, remote, hooks, deviceId, now } = deps;
  const own = `${PRESENCE_PREFIX}${deviceId}`;
  const seen = new Map<string, Seen>();
  const agents = new Map<string, Set<string>>();
  let cursor: SyncCursor | null = null;
  let first = true;
  let published: string | null = null;
  let publishedAt = 0;
  let nextSweep = 0;
  let publishedOid: string | null = null;
  /** A commit's oid is its content: a republish within a second must differ. */
  let beat = 0;

  const treePath = (path: string) => pathutil.toTreePath(pathutil.relative(deps.root, path) || path);

  const offTool = hooks.on("agent:tool-call", ({ workspacePath, taskId, toolCall }) => {
    if (pathutil.normalize(workspacePath) !== deps.root) return;
    const paths = (toolCall.locations ?? []).map((location) => treePath(location.path));
    if (toolCall.status && ACTIVE.has(toolCall.status)) {
      const held = agents.get(taskId) ?? new Set<string>();
      agents.set(taskId, new Set([...held, ...paths]));
    } else {
      for (const path of paths) agents.get(taskId)?.delete(path);
      if (agents.get(taskId)?.size === 0) agents.delete(taskId);
    }
  });
  const offSettled = hooks.on("agent:turn-settled", ({ taskId }) => void agents.delete(taskId));

  /** Fetch the payloads of the refs that moved, one fetch each. */
  const readMoved = async (moved: GitRemoteRef[]) => {
    if (moved.length === 0) return;
    const fetched = await git.fetchRefs(remote, moved.map((ref) => ref.ref), { transient: true });
    await Promise.all(
      fetched.map(async ({ ref, oid }) => {
        const entry = seen.get(ref);
        if (!oid || !entry) return;
        const [tip] = await git.log({ ref: oid, depth: 1 }).catch(() => []);
        if (tip) entry.peer = parsePeer(ref.slice(PRESENCE_PREFIX.length), tip.commit.message) ?? entry.peer;
      }),
    );
  };

  /** Sweep the ref that has stood still longest past its window. */
  const sweep = async (at: number) => {
    if (at < nextSweep) return;
    const stalest = [...seen.entries()]
      .filter(([, entry]) => at - entry.since > entry.sweepAfter)
      .sort(([, a], [, b]) => a.since - b.since)[0];
    if (!stalest) return;
    nextSweep = at + SWEEP_EVERY_MS;
    const [ref, entry] = stalest;
    // Moved in between, or lost the race to another client: harmless.
    await git.pushRef(remote, { ref, delete: true, force: true, expect: entry.oid }).catch(() => {});
    seen.delete(ref);
  };

  const live = (at: number) =>
    [...seen.values()]
      .filter((entry) => entry.peer && entry.movedAt !== null && at - entry.movedAt < PRESENCE_STALE_MS)
      .map((entry) => entry.peer as SyncPeer)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));

  return {
    /** One poll's refs: stamp what moved, read it, announce who is here. */
    async observe(refs: GitRemoteRef[]) {
      const at = now();
      const present = refs.filter((ref) => ref.ref.startsWith(PRESENCE_PREFIX) && ref.ref !== own);
      const moved: GitRemoteRef[] = [];
      let joined = false;
      for (const { ref, oid } of present) {
        const entry = seen.get(ref);
        if (entry?.oid === oid) continue;
        if (!entry && !first) joined = true;
        const sweepAfter = STALE_DELETE_MS + deps.random() * SWEEP_JITTER_MS;
        seen.set(ref, { oid, movedAt: first ? null : at, peer: entry?.peer ?? null, since: at, sweepAfter });
        moved.push({ ref, oid });
      }
      for (const ref of [...seen.keys()]) if (!present.some((r) => r.ref === ref)) seen.delete(ref);
      first = false;
      if (joined) published = null;
      await readMoved(moved);
      await sweep(at);
      const peers = live(at);
      if (JSON.stringify(peers) !== JSON.stringify(deps.state().peers)) deps.dispatch({ type: "peers", peers });
    },
    /** Replace this device's ref when its payload changed or a heartbeat
     *  is due. */
    async publish() {
      const body = { name: deps.name, cursor, agents: [...agents.values()].map((paths) => ({ paths: [...paths] })) };
      const payload = JSON.stringify(body);
      if (payload === published && now() - publishedAt < HEARTBEAT_MS) return;
      const [tip] = await git.log({ ref: deps.branchRef, depth: 1 }).catch(() => []);
      if (!tip) return;
      const oid = await git.commit({
        message: JSON.stringify({ ...body, beat: ++beat }),
        author: deps.author,
        tree: tip.commit.tree,
        parent: [tip.oid],
        noUpdateBranch: true,
      });
      await git.pushRef(remote, { ref: own, oid, force: true });
      // What this replaced is unreachable now, and so are old fetched packs.
      const replaced = publishedOid;
      publishedOid = oid;
      await git.sweepTransient({ olderThanMs: TRANSIENT_OBJECTS_MS, oids: replaced ? [replaced] : [] }).catch(() => {});
      published = payload;
      publishedAt = now();
    },
    /** Where this device's caret is now (a `path`, unit and offset). */
    setCursor(next: SyncCursor | null) {
      cursor = next;
    },
    /** Leave: delete the ref so the others see it at once. */
    async leave() {
      offTool();
      offSettled();
      await git.pushRef(remote, { ref: own, delete: true, force: true }).catch(() => {});
    },
  };
}
