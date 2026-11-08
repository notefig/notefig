/**
 * Claims and work in progress: while shared, each device's edits live on
 * `refs/notefig/v1/wip/<deviceId>`, a snapshot commit on the branch tip
 * replaced on each change (only its objects are new). The message lists
 * the units it holds: by the base version's text, so every device names a
 * unit the same way without aligning anything. Holding is having changed:
 * a unit edited or deleted is claimed, a unit created is simply yours. A
 * claim lasts as long as its device's presence, ends after a short pause
 * in saving (the text stays uncommitted, so a collision with it merges and
 * is flagged), and the fold (one commit per sitting) ends what is left by
 * deleting the ref.
 *
 * Who wins a race is deterministic, with no arbitration: of two devices
 * claiming one unit, the lower device id holds it, and the other's text
 * goes back to the base, flagged.
 */
import { diffArrays } from "diff";
import type { GitRemote, GitRemoteRef, GitService } from "@notefig/git";
import { path as pathutil } from "@/utils/path";
import { splitUnits } from "./sync-merge";
import type { SyncPeer, SyncState } from "./sync-machine";

export const WIP_PREFIX = "refs/notefig/v1/wip/";

const MARKDOWN = /\.(md|markdown)$/i;

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
}

export const unitTexts = (markdown: string) => splitUnits(markdown).map((unit) => unit.text);

/** One key per unit: its text's hash and which occurrence of it this is. */
export function unitKeys(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const hash = fnv(text);
    const nth = seen.get(hash) ?? 0;
    seen.set(hash, nth + 1);
    return `${hash}.${nth}`;
  });
}

/** The units of `base` that `next` edited or deleted. */
export function changedKeys(base: string, next: string): string[] {
  const kept = new Set(unitKeys(unitTexts(next)));
  return unitKeys(unitTexts(base)).filter((key) => !kept.has(key));
}

/** `changedKeys`, without the units already let go: those whose text is
 *  still as it was in `released`, the file when the claims last ended. */
export function freshKeys(base: string, next: string, released: string): string[] {
  const had = new Set(unitTexts(released));
  const [baseTexts, nextTexts] = [unitTexts(base), unitTexts(next)];
  const keys = unitKeys(baseTexts);
  return unitHunks(baseTexts, nextTexts).flatMap((hunk) =>
    pairs(hunk).flatMap(([from, count, to, added]) => {
      const fresh =
        added > 0
          ? nextTexts.slice(to, to + added).some((text) => !had.has(text))
          : baseTexts.slice(from, from + count).some((text) => had.has(text));
      return fresh ? keys.slice(from, from + count) : [];
    }),
  );
}

/** A stretch of units `a` and `b` differ on: `a[from..from+removed]`
 *  became `added`, at `to` in `b`. */
export interface UnitHunk {
  from: number;
  removed: number;
  to: number;
  added: string[];
}

export function unitHunks(a: string[], b: string[]): UnitHunk[] {
  const hunks: UnitHunk[] = [];
  const parts = diffArrays(a, b);
  let at = 0;
  let to = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      at += count;
      to += count;
      continue;
    }
    const partner = parts[i + 1] && Boolean(part.added) !== Boolean(parts[i + 1].added) && (parts[i + 1].added || parts[i + 1].removed) ? parts[++i] : null;
    const removed = part.removed ? count : (partner?.count ?? 0);
    const added = part.added ? part.value : (partner?.value ?? []);
    hunks.push({ from: at, removed, to, added });
    at += removed;
    to += added.length;
  }
  return hunks;
}

/** A hunk's unit pairs: unit for unit when the counts match. */
function pairs(hunk: UnitHunk): [number, number, number, number][] {
  if (hunk.removed !== hunk.added.length) return [[hunk.from, hunk.removed, hunk.to, hunk.added.length]];
  return Array.from({ length: hunk.removed }, (_, i) => [hunk.from + i, 1, hunk.to + i, 1]);
}

/** `next` with the units claimed in `lost` put back as `base` had them;
 *  null when none are among its changes. `dropped` is what came out. */
export function revertUnits(base: string, next: string, lost: Set<string>): { text: string; dropped: string[] } | null {
  const [baseUnits, nextUnits] = [splitUnits(base), splitUnits(next)];
  const baseKeys = unitKeys(baseUnits.map((unit) => unit.text));
  const out: string[] = [];
  const dropped: string[] = [];
  const keep = (units: { text: string; gap: string }[]) => out.push(...units.map((unit) => unit.text + unit.gap));
  let at = 0;
  for (const hunk of unitHunks(baseUnits.map((unit) => unit.text), nextUnits.map((unit) => unit.text))) {
    keep(baseUnits.slice(at, hunk.from));
    for (const [from, count, to, added] of pairs(hunk)) {
      const taken = baseKeys.slice(from, from + count).some((key) => lost.has(key));
      keep(taken ? baseUnits.slice(from, from + count) : nextUnits.slice(to, to + added));
      if (taken) dropped.push(...nextUnits.slice(to, to + added).map((unit) => unit.text));
    }
    at = hunk.from + hunk.removed;
  }
  keep(baseUnits.slice(at));
  return dropped.length > 0 ? { text: out.join(""), dropped } : null;
}

export interface PeerHold {
  peer: SyncPeer;
  keys: Set<string>;
  /** The file as this peer has it; null when it can't be read. */
  text: string | null;
}

interface PeerWip {
  oid: string;
  claims: Record<string, string[]>;
}

export interface ClaimsDeps {
  root: string;
  deviceId: string;
  author: { name: string; email: string };
  git: GitService;
  remote: GitRemote;
  branchRef: string;
  fs: { readFiles(paths: string[]): Promise<{ succeeded: { path: string; content: string }[] }> };
  state(): SyncState;
}

export function createClaims(deps: ClaimsDeps) {
  const { git, remote, deviceId, root } = deps;
  const own = `${WIP_PREFIX}${deviceId}`;
  const peers = new Map<string, PeerWip>();
  const absolute = (path: string) => pathutil.join(root, pathutil.fromTreePath(path));
  /** What this device published last: its claims, by document. */
  let mine: Record<string, string[]> = {};
  /** Each document as it was when its claims last ended, this sitting. */
  let released: Record<string, string> = {};
  /** The last snapshot this device published. */
  let wip: string | null = null;
  let active = false;

  const asText = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : "");

  const livePeers = () => new Map(deps.state().peers.map((peer) => [peer.deviceId, peer]));

  /** Does `deviceId`'s claim on `key` win over this device's? */
  const beats = (peerId: string, path: string, key: string) =>
    !(mine[path] ?? []).includes(key) || peerId < deviceId;

  /** Others' claims in force on `path`: key → the peer who holds it. */
  const held = (path: string): Map<string, SyncPeer> => {
    const out = new Map<string, SyncPeer>();
    const live = livePeers();
    for (const [id, wip] of peers) {
      const peer = live.get(id);
      if (!peer) continue;
      for (const key of wip.claims[path] ?? []) if (beats(id, path, key)) out.set(key, peer);
    }
    return out;
  };

  return {
    /** One poll's WIP refs: read the ones that moved, drop the rest. */
    async observe(refs: GitRemoteRef[]) {
      const present = refs.filter((ref) => ref.ref.startsWith(WIP_PREFIX));
      if (!active && present.some((ref) => ref.ref === own)) {
        // Left over from a session that ended without folding; its edits
        // are on disk and go in with the next commit.
        await git.pushRef(remote, { ref: own, delete: true, force: true }).catch(() => {});
      }
      const others = present.filter((ref) => ref.ref !== own);
      const moved = others.filter((ref) => peers.get(ref.ref.slice(WIP_PREFIX.length))?.oid !== ref.oid);
      for (const id of [...peers.keys()]) {
        if (!others.some((ref) => ref.ref === `${WIP_PREFIX}${id}`)) peers.delete(id);
      }
      if (moved.length === 0) return;
      for (const { ref, oid } of await git.fetchRefs(remote, moved.map((m) => m.ref))) {
        if (!oid) continue;
        const [tip] = await git.log({ ref: oid, depth: 1 }).catch(() => []);
        if (!tip) continue;
        try {
          const claims = (JSON.parse(tip.commit.message) as { claims?: Record<string, string[]> }).claims ?? {};
          peers.set(ref.slice(WIP_PREFIX.length), { oid, claims });
        } catch {
          // Not a payload this version reads: it holds nothing here.
        }
      }
    },

    /** Replace this device's WIP ref with the index's state. */
    async publish(paths: string[]) {
      const [tip] = await git.log({ ref: deps.branchRef, depth: 1 });
      const docs = paths.filter((path) => MARKDOWN.test(path));
      const { succeeded } = await deps.fs.readFiles(docs.map(absolute));
      const current = new Map(succeeded.map((file) => [file.path, file.content]));
      const claims: Record<string, string[]> = {};
      for (const path of docs) {
        const base = asText(await git.readFile({ ref: tip.oid, filepath: path }));
        const text = current.get(absolute(path)) ?? "";
        const keys = released[path] === undefined ? changedKeys(base, text) : freshKeys(base, text, released[path]);
        if (keys.length > 0) claims[path] = keys;
      }
      mine = claims;
      active = true;
      const oid = await git.commit({
        message: JSON.stringify({ claims }),
        author: deps.author,
        parent: [tip.oid],
        noUpdateBranch: true,
      });
      await git.pushRef(remote, { ref: own, oid, force: true });
      wip = oid;
    },

    ownWip: () => wip,

    /** A pause in saving: others may edit these units again. Only a
     *  further change to one claims it back. */
    async idle() {
      if (!active) return;
      const paths = Object.keys(mine);
      const { succeeded } = await deps.fs.readFiles(paths.map(absolute));
      const current = new Map(succeeded.map((file) => [file.path, file.content]));
      for (const path of paths) released[path] = current.get(absolute(path)) ?? "";
      mine = {};
      active = false;
      await git.pushRef(remote, { ref: own, delete: true, force: true });
    },

    /** The sitting folded: the claims end with the ref. */
    async release() {
      mine = {};
      released = {};
      if (!active) return;
      active = false;
      await git.pushRef(remote, { ref: own, delete: true, force: true });
    },

    held,

    /** What this device claimed and lost: `path` → keys. */
    lost(): Map<string, Set<string>> {
      const out = new Map<string, Set<string>>();
      const live = livePeers();
      for (const [path, keys] of Object.entries(mine)) {
        const beaten = keys.filter((key) =>
          [...peers].some(([id, wip]) => live.has(id) && id < deviceId && wip.claims[path]?.includes(key)),
        );
        if (beaten.length > 0) out.set(path, new Set(beaten));
      }
      return out;
    },

    /** What others hold in `path`, with each one's text of it. */
    async holds(path: string): Promise<PeerHold[]> {
      const live = livePeers();
      const out: PeerHold[] = [];
      const inForce = held(path);
      for (const [id, wip] of peers) {
        const peer = live.get(id);
        const keys = (wip.claims[path] ?? []).filter((key) => inForce.get(key)?.deviceId === id);
        if (!peer || keys.length === 0) continue;
        const bytes = await git.readFile({ ref: wip.oid, filepath: path }).catch(() => null);
        out.push({ peer, keys: new Set(keys), text: bytes ? asText(bytes) : null });
      }
      return out;
    },

    /** Why an agent's write to `path` (`current` → `next`) may not go on;
     *  null when every unit it touches is free or its own. */
    refusal(path: string, current: string, next: string): string | null {
      const inForce = held(path);
      if (inForce.size === 0) return null;
      const blocked = changedKeys(current, next).flatMap((key) => inForce.get(key) ?? []);
      if (blocked.length === 0) return null;
      const names = [...new Set(blocked.map((peer) => peer.name))].join(" and ");
      return `Refused: ${names} ${blocked.length > 1 && names.includes(" and ") ? "are" : "is"} editing ${path.split("/").pop()}. Nothing was written. Make a targeted edit that leaves those paragraphs alone, or try again when they're done.`;
    },
  };
}
