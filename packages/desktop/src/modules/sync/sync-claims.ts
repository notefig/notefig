/**
 * Claims (MET-273): while sync is shared, a unit someone is editing is
 * theirs until they're done, and nobody else's edit lands on it. One rule
 * set for people and agents: the holder is a device, and a user's agents
 * edit under the user's claims, so typing where your own agent is writing
 * is never refused. The same person on two devices is two holders.
 *
 * Claims travel in the device's presence commit (`sync-presence.ts`), so
 * they cost no request of their own and go when the presence does. A claim
 * names its unit by keys (`sync-units.ts`): what the unit said before the
 * edit, what it said when the edit last reached the branch, and what it
 * says now. Another device finds it by whichever its copy has.
 *
 * - Editing a unit claims it, unless another device holds it; then the
 *   edit is refused before anything changes. A unit you create is yours as
 *   soon as it exists, if there's room.
 * - A device holds at most `MAX_CLAIMS` units, its user's and its agents'
 *   together. An edit that needs more is refused.
 * - A claim ends `CLAIM_IDLE_MS` after its last edit, or once the caret
 *   has left the unit and the edit is on the branch. An agent has no caret:
 *   its claims end once its edits are on the branch.
 * - Two devices that claim one unit within a poll of each other: the lower
 *   device id holds it. The other one's text is merged three ways, as any
 *   collision is (`sync-merge.ts`).
 *
 * Pure state: no I/O, no timers. The engine calls `landed` and `expire`
 * from its cycle.
 */
import { diffArrays } from "diff";
import type { SyncClaim, SyncPeer } from "./sync-machine";

/** Units one device holds at most, its user's and its agents' together. */
export const MAX_CLAIMS = 4;
/** A claim with no edit this long ends. */
export const CLAIM_IDLE_MS = 10_000;
/** Keys a claim names its unit by, at most: as it was, as it landed, now. */
const MAX_ORIGIN_KEYS = 2;
const MAX_LANDED_KEYS = 2;
/** An edit this recent may still be in the editor's autosave. */
const SAVE_SLACK_MS = 1_500;

/** Who holds a unit another device is editing. */
export interface ClaimHolder {
  peer: SyncPeer;
  agent: boolean;
}

export type ClaimRefusal =
  /** Another device holds units the edit touches. */
  | { kind: "held"; holders: ClaimHolder[] }
  /** The edit would make this device hold more than `MAX_CLAIMS`. */
  | { kind: "cap"; needed: number };

/** One edit to a file: the keys of the units it touched as they were
 *  (null for an empty textblock), and of what's there after. */
export interface ClaimEdit {
  before: (string | null)[];
  after: (string | null)[];
}

interface Own {
  path: string;
  /** What the unit (or the units joined into it) said before the edit. */
  origin: string[];
  /** What it said when its edits last reached the branch. */
  landed: string[];
  /** What it says now; null once it's deleted. */
  current: string | null;
  lastEdit: number;
  /** Its last edit is on the branch. */
  onBranch: boolean;
  agent: boolean;
}

export interface Claims {
  /** Claim what an edit to `path` touches, or say why not; nothing is
   *  claimed on a refusal. */
  take(path: string, edit: ClaimEdit, agent: boolean): ClaimRefusal | null;
  /** Would `take` refuse? Claims nothing. */
  check(path: string, edit: ClaimEdit): ClaimRefusal | null;
  /** Other devices' claims in force on `path`, by unit key. */
  heldIn(path: string): Map<string, ClaimHolder>;
  /** Where this device's caret is: a file and its unit's key. */
  setCaret(caret: { path: string; key: string | null } | null): void;
  /** A cycle that began at `at` put everything saved by then on the
   *  branch; `unsaved` says which files still hold edits. It's asked only
   *  of claims the caret has left, since asking saves at once. */
  landed(at: number, unsaved: (path: string) => boolean): void;
  /** End what's idle, left and on the branch, or beaten by another device;
   *  true when anything ended. */
  expire(): boolean;
  /** What this device holds, as it's sent. */
  published(): SyncClaim[];
  /** Nobody else is here: nothing to hold. */
  clear(): void;
}

const keysOf = (own: Own) => [...new Set([...own.origin, ...own.landed, ...(own.current ? [own.current] : [])])];

export function createClaims(deps: { deviceId: string; now(): number; peers(): readonly SyncPeer[] }): Claims {
  let own: Own[] = [];
  let caret: { path: string; key: string | null } | null = null;
  /** Units this device was editing when another device won them. */
  let yielded: { path: string; keys: string[]; peerId: string }[] = [];

  const isHere = (entry: Own) => caret?.path === entry.path && caret.key !== null && caret.key === entry.current;

  /** Of two devices claiming one unit, the lower id holds it. */
  const beats = (peerId: string) => peerId < deps.deviceId;

  /** The device that won a unit from this one, and its claim on it. */
  const winnerOf = (path: string, keys: string[], peerId?: string): ClaimHolder | null => {
    for (const peer of deps.peers()) {
      if (peerId ? peer.deviceId !== peerId : !beats(peer.deviceId)) continue;
      const claim = peer.claims.find((c) => c.path === path && c.keys.some((key) => keys.includes(key)));
      if (claim) return { peer, agent: claim.agent };
    }
    return null;
  };

  /** Others' claims on `path` in force: all but the races this device won,
   *  where it holds the unit and the other merges. */
  const othersIn = (path: string, held: Map<string, ClaimHolder>) => {
    const mine = new Set(own.filter((entry) => entry.path === path).flatMap(keysOf));
    for (const peer of deps.peers()) {
      for (const claim of peer.claims) {
        const won = !beats(peer.deviceId) && claim.keys.some((key) => mine.has(key));
        if (claim.path !== path || won) continue;
        for (const key of claim.keys) held.set(key, { peer, agent: claim.agent });
      }
    }
  };

  /** The races this device lost on `path`: its own text of each unit is
   *  the winner's too, whatever the winner's copy says, until it lets go. */
  const lostIn = (path: string, held: Map<string, ClaimHolder>) => {
    const lost = [
      ...own.filter((entry) => entry.path === path).map((entry) => ({ keys: keysOf(entry), peerId: undefined })),
      ...yielded.filter((entry) => entry.path === path),
    ];
    for (const { keys, peerId } of lost) {
      const winner = winnerOf(path, keys, peerId);
      if (winner) for (const key of keys) held.set(key, winner);
    }
  };

  const heldIn = (path: string) => {
    const held = new Map<string, ClaimHolder>();
    othersIn(path, held);
    lostIn(path, held);
    return held;
  };

  /** The claims an edit leaves, or why it can't go on. */
  const plan = (path: string, edit: ClaimEdit, agent: boolean): ClaimRefusal | Own[] => {
    const before = edit.before.filter((key): key is string => key !== null);
    const held = heldIn(path);
    const holders = new Map<string, ClaimHolder>();
    for (const key of before) {
      const holder = held.get(key);
      if (holder) holders.set(`${holder.peer.deviceId}:${holder.agent}`, holder);
    }
    if (holders.size > 0) return { kind: "held", holders: [...holders.values()] };
    const at = deps.now();
    const touched = own.filter((entry) => entry.path === path && before.some((key) => keysOf(entry).includes(key)));
    const rest = own.filter((entry) => !touched.includes(entry));
    // Each unit touched, with the claim it already had.
    const groups = before.map((key) => touched.find((entry) => keysOf(entry).includes(key)) ?? key);
    const distinct = [...new Set(groups)];
    const after = edit.after.filter((key): key is string => key !== null);
    const claimed: Own[] = distinct.map((group, i) => {
      const prior = typeof group === "string" ? null : group;
      return {
        path,
        origin: prior?.origin ?? [group as string],
        landed: prior?.landed ?? [],
        current: after[i] ?? null,
        lastEdit: at,
        onBranch: false,
        agent,
      };
    });
    // Units joined into one: the last that's left names them all.
    if (claimed.length > after.length && after.length > 0) {
      const into = claimed[after.length - 1]!;
      for (const joined of claimed.splice(after.length)) {
        into.origin = [...new Set([...into.origin, ...joined.origin])].slice(-MAX_ORIGIN_KEYS);
      }
    }
    const next = [...rest, ...claimed];
    if (next.length > MAX_CLAIMS) return { kind: "cap", needed: next.length };
    // Units the edit created: nobody else has them yet, so they're held
    // while there's room, and never refused.
    for (const key of after.slice(distinct.length)) {
      if (next.length >= MAX_CLAIMS) break;
      next.push({ path, origin: [], landed: [], current: key, lastEdit: at, onBranch: false, agent });
    }
    return next;
  };

  return {
    take(path, edit, agent) {
      const next = plan(path, edit, agent);
      if (!Array.isArray(next)) return next;
      own = next;
      return null;
    },
    check(path, edit) {
      const next = plan(path, edit, false);
      return Array.isArray(next) ? null : next;
    },
    heldIn,
    setCaret(next) {
      caret = next;
    },
    landed(at, unsaved) {
      for (const entry of own) {
        // Typed since, or still in the autosave on its way to disk.
        if (entry.lastEdit >= at - SAVE_SLACK_MS) continue;
        // What the others have now, so they find the unit by it.
        if (entry.current && !entry.landed.includes(entry.current)) {
          entry.landed = [...entry.landed, entry.current].slice(-MAX_LANDED_KEYS);
        }
        // Asked only once the caret's gone: asking saves now.
        if (!entry.onBranch && (entry.agent || !isHere(entry)) && !unsaved(entry.path)) entry.onBranch = true;
      }
    },
    expire() {
      const at = deps.now();
      const [ownBefore, yieldedBefore] = [own.length, yielded.length];
      yielded = yielded.filter(({ path, keys, peerId }) => winnerOf(path, keys, peerId) !== null);
      own = own.filter((entry) => {
        if (at - entry.lastEdit >= CLAIM_IDLE_MS) return false;
        if (entry.onBranch && (entry.agent || !isHere(entry))) return false;
        // Lost a race: the other device holds it, and this one yields.
        const keys = keysOf(entry);
        const winner = winnerOf(entry.path, keys);
        if (winner) yielded.push({ path: entry.path, keys, peerId: winner.peer.deviceId });
        return !winner;
      });
      return own.length !== ownBefore || yielded.length !== yieldedBefore;
    },
    published: () => own.map((entry) => ({ path: entry.path, keys: keysOf(entry), agent: entry.agent })),
    clear() {
      own = [];
      yielded = [];
    },
  };
}

/** What turns one file's unit keys into the other's: the units changed or
 *  deleted, and what's there instead (paired first, created last). */
export function editBetween(before: string[], after: string[]): ClaimEdit {
  const touched: string[] = [];
  const paired: string[] = [];
  const created: string[] = [];
  const parts = diffArrays(before, after);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.removed && !part.added) continue;
    const next = parts[i + 1];
    const partner = next && (part.removed ? next.added : next.removed) ? (i++, next) : null;
    const removed = part.removed ? part.value : (partner?.value ?? []);
    const added = part.added ? part.value : (partner?.value ?? []);
    touched.push(...removed);
    paired.push(...added.slice(0, removed.length));
    created.push(...added.slice(removed.length));
  }
  return { before: touched, after: [...paired, ...created] };
}

/** Why an agent's write was refused, for the agent: who to wait for, and
 *  how to go on. */
export function refusalMessage(path: string, refusal: ClaimRefusal): string {
  const file = path.split("/").pop() ?? path;
  if (refusal.kind === "cap") {
    return `Refused: while others are in ${file}, a device edits at most ${MAX_CLAIMS} paragraphs at a time, and this edit would make ${refusal.needed}. Nothing was written. Make smaller edits, a few paragraphs at a time.`;
  }
  const names = [...new Set(refusal.holders.map(({ peer, agent }) => `${peer.name ?? "someone"}${agent ? "'s agent" : ""}`))];
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are` : `${names[0]} is`;
  return `Refused: ${who} editing paragraphs of ${file} this edit touches. Nothing was written. Edit other paragraphs, or try again in a few seconds.`;
}
