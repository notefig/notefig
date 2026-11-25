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
 * - A claim ends once its edit is on the branch and the user is done with
 *   it: the caret has left the unit, or `CLAIM_IDLE_MS` passed with no
 *   edit. An agent has no caret: its claims end once its edits are on the
 *   branch. Never before: the others would see the unit free while the
 *   branch still has its old text.
 * - Two devices that claim one unit within a poll of each other: the lower
 *   device id holds it. The other one's text is merged three ways, as any
 *   collision is (`sync-merge.ts`).
 *
 * Pure state: no I/O, no timers. The engine calls `landed` and `expire`
 * from its cycle.
 */
import { diffArrays } from "diff";
import type { SyncClaim, SyncPeer } from "./sync-machine";
import { sameUnit, type FileUnit, type UnitIndex } from "./sync-units";

/** Units one device holds at most, its user's and its agents' together. */
export const MAX_CLAIMS = 4;
/** A claim with no edit this long ends. */
export const CLAIM_IDLE_MS = 10_000;
/** What it said as it landed, kept at most. */
const MAX_LANDED_KEYS = 2;
/** Keys one claim names its unit by, at most: every unit joined into it as
 *  it was, as it landed, and now. A join that needs more is refused, so no
 *  unit it changed goes unnamed. */
export const MAX_CLAIM_KEYS = 12;
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
   *  claimed on a refusal. `index` is the file as the edit found it, where
   *  every claim's keys are looked up. */
  take(path: string, edit: ClaimEdit, agent: boolean, index: UnitIndex): ClaimRefusal | null;
  /** Other devices' claims in force on `path`, by the key of the unit each
   *  names in the copy `index` indexes. */
  heldIn(path: string, index: UnitIndex): Map<string, ClaimHolder>;
  /** Where this device's caret is: a file and its unit's key. */
  setCaret(caret: { path: string; key: string | null } | null): void;
  /** A cycle that began at `at` put everything saved by then on the
   *  branch; `unsaved` says which files still hold edits. It's asked only
   *  of claims the user is done with, since asking saves at once. */
  landed(at: number, unsaved: (path: string) => boolean): void;
  /** What the units this device holds in `path` say on the branch now:
   *  `onBranch` gives it for a unit's key here (`branchKeys`). Each claim
   *  names its unit by that too, so a device whose copy is the branch finds
   *  it while this one is still typing in it. */
  branchHas(path: string, onBranch: (key: string) => string | undefined): void;
  /** End what's on the branch and done with, or beaten by another device;
   *  true when anything ended. */
  expire(): boolean;
  /** What this device holds, as it's sent. */
  published(): SyncClaim[];
  /** The user is typing in a unit they hold: their caret is in it, and
   *  their last edit to it isn't idle yet. */
  typing(): boolean;
  /** Nobody else is here: nothing to hold. */
  clear(): void;
}

const keysOf = (own: Own) => [...new Set([...own.origin, ...own.landed, ...(own.current ? [own.current] : [])])];

export function createClaims(deps: { deviceId: string; now(): number; peers(): readonly SyncPeer[] }): Claims {
  let own: Own[] = [];
  let caret: { path: string; key: string | null } | null = null;
  /** Units this device was editing when another device won them. */
  let yielded: { path: string; keys: string[]; peerId: string }[] = [];

  /** The user is at this claim's unit: the caret is in it, though the text
   *  around it moved, and they edited it within `CLAIM_IDLE_MS`. */
  const isHere = (entry: Own) =>
    deps.now() - entry.lastEdit < CLAIM_IDLE_MS &&
    caret?.path === entry.path && caret.key !== null && entry.current !== null && sameUnit(caret.key, entry.current);

  /** Of two devices claiming one unit, the lower id holds it. */
  const beats = (peerId: string) => peerId < deps.deviceId;

  /** Keys as units of one copy of the file: each looked up in `index`
   *  (`sync-units.ts`); without one, as they are. */
  const here = (keys: string[], index?: UnitIndex) =>
    index ? keys.flatMap((key) => index.resolve(key) ?? []) : keys;

  /** Two claims on one unit: one key in both naming the same unit (what it
   *  said before either edit, though the unit above changed on one side), or
   *  the same unit of this copy. */
  const overlap = (a: string[], b: string[], index?: UnitIndex) => {
    if (a.some((key) => b.some((other) => sameUnit(key, other)))) return true;
    const units = new Set(here(a, index));
    return index !== undefined && here(b, index).some((key) => units.has(key));
  };

  /** The device that won a unit from this one, and its claim on it. */
  const winnerOf = (path: string, keys: string[], peerId?: string, index?: UnitIndex): ClaimHolder | null => {
    for (const peer of deps.peers()) {
      if (peerId ? peer.deviceId !== peerId : !beats(peer.deviceId)) continue;
      const claim = peer.claims.find((c) => c.path === path && overlap(c.keys, keys, index));
      if (claim) return { peer, agent: claim.agent };
    }
    return null;
  };

  /** Others' claims on `path` in force: all but the races this device won,
   *  where it holds the unit and the other merges. */
  const othersIn = (path: string, index: UnitIndex, held: Map<string, ClaimHolder>) => {
    const mine = own.filter((entry) => entry.path === path).flatMap(keysOf);
    for (const peer of deps.peers()) {
      for (const claim of peer.claims) {
        if (claim.path !== path) continue;
        if (!beats(peer.deviceId) && overlap(claim.keys, mine, index)) continue;
        for (const key of here(claim.keys, index)) held.set(key, { peer, agent: claim.agent });
      }
    }
  };

  /** The races this device lost on `path`: its own text of each unit is
   *  the winner's too, whatever the winner's copy says, until it lets go. */
  const lostIn = (path: string, index: UnitIndex, held: Map<string, ClaimHolder>) => {
    const lost = [
      ...own.filter((entry) => entry.path === path).map((entry) => ({ keys: keysOf(entry), peerId: undefined })),
      ...yielded.filter((entry) => entry.path === path),
    ];
    for (const { keys, peerId } of lost) {
      const winner = winnerOf(path, keys, peerId, index);
      if (winner) for (const key of here(keys, index)) held.set(key, winner);
    }
  };

  const heldIn = (path: string, index: UnitIndex) => {
    const held = new Map<string, ClaimHolder>();
    othersIn(path, index, held);
    lostIn(path, index, held);
    return held;
  };

  /** The claims an edit leaves, or why it can't go on. */
  const plan = (path: string, edit: ClaimEdit, agent: boolean, index: UnitIndex): ClaimRefusal | Own[] => {
    const before = edit.before.filter((key): key is string => key !== null);
    const held = heldIn(path, index);
    const holders = new Map<string, ClaimHolder>();
    for (const key of before) {
      const holder = held.get(key);
      if (holder) holders.set(`${holder.peer.deviceId}:${holder.agent}`, holder);
    }
    if (holders.size > 0) return { kind: "held", holders: [...holders.values()] };
    const at = deps.now();
    const names = (entry: Own) => here(keysOf(entry), index);
    const touched = own.filter((entry) => entry.path === path && before.some((key) => names(entry).includes(key)));
    const rest = own.filter((entry) => !touched.includes(entry));
    // Each unit touched, with the claim it already had.
    const groups = before.map((key) => touched.find((entry) => names(entry).includes(key)) ?? key);
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
        into.origin = [...new Set([...into.origin, ...joined.origin])];
      }
    }
    const next = [...rest, ...claimed];
    if (next.length > MAX_CLAIMS || claimed.some((entry) => keysOf(entry).length > MAX_CLAIM_KEYS)) {
      return { kind: "cap", needed: Math.max(next.length, MAX_CLAIMS + 1) };
    }
    // Units the edit created: nobody else has them yet, so they're held
    // while there's room, and never refused.
    for (const key of after.slice(distinct.length)) {
      if (next.length >= MAX_CLAIMS) break;
      next.push({ path, origin: [], landed: [], current: key, lastEdit: at, onBranch: false, agent });
    }
    return next;
  };

  return {
    take(path, edit, agent, index) {
      const next = plan(path, edit, agent, index);
      if (!Array.isArray(next)) return next;
      own = next;
      return null;
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
        // Asked only once the user's done with it: asking saves now.
        if (!entry.onBranch && (entry.agent || !isHere(entry)) && !unsaved(entry.path)) entry.onBranch = true;
      }
    },
    branchHas(path, onBranch) {
      for (const entry of own) {
        const there = entry.path === path && entry.current ? onBranch(entry.current) : undefined;
        if (there && !entry.landed.includes(there)) entry.landed = [...entry.landed, there].slice(-MAX_LANDED_KEYS);
      }
    },
    expire() {
      const [ownBefore, yieldedBefore] = [own.length, yielded.length];
      yielded = yielded.filter(({ path, keys, peerId }) => winnerOf(path, keys, peerId) !== null);
      own = own.filter((entry) => {
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
    typing: () => own.some((entry) => !entry.agent && isHere(entry)),
    clear() {
      own = [];
      yielded = [];
    },
  };
}

/** What turns one file into the other: the units changed or deleted, and
 *  what's there instead (paired first, created last), by key. Compared by
 *  whole content, so a write that only bolds a word or changes a link
 *  touches its unit. */
export function editBetween(before: FileUnit[], after: FileUnit[]): ClaimEdit {
  const touched: string[] = [];
  const paired: string[] = [];
  const created: string[] = [];
  const parts = diffArrays(before, after, { comparator: (a, b) => a.content === b.content });
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.removed && !part.added) continue;
    const next = parts[i + 1];
    const partner = next && (part.removed ? next.added : next.removed) ? (i++, next) : null;
    const removed = (part.removed ? part.value : (partner?.value ?? [])).map((unit) => unit.key);
    const added = (part.added ? part.value : (partner?.value ?? [])).map((unit) => unit.key);
    touched.push(...removed);
    paired.push(...added.slice(0, removed.length));
    created.push(...added.slice(removed.length));
  }
  return { before: touched, after: [...paired, ...created] };
}

/** For each unit of `here` that one of `branch` turned into, the key that
 *  one has there: the same unit, as the branch has it. Units alike in both
 *  pair up, and so do those an edit changed, in order (`editBetween`). */
export function branchKeys(branch: FileUnit[], here: FileUnit[]): Map<string, string> {
  const keys = new Map<string, string>();
  const pair = (h: number, b: number, count: number) => {
    for (let k = 0; k < count; k++) keys.set(here[h + k]!.key, branch[b + k]!.key);
  };
  let [b, h] = [0, 0];
  // The last run the edit removed: the run added right after it replaced
  // it (jsdiff puts removals first).
  let removed = { at: 0, count: 0 };
  for (const part of diffArrays(branch, here, { comparator: (x, y) => x.content === y.content })) {
    const count = part.value.length;
    if (part.removed) {
      removed = { at: b, count };
      b += count;
      continue;
    }
    pair(h, part.added ? removed.at : b, part.added ? Math.min(count, removed.count) : count);
    h += count;
    if (!part.added) b += count;
    removed = { at: b, count: 0 };
  }
  return keys;
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
