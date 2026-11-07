/**
 * The lease rules (MET-266 decisions 6, 8, 9 and 11): the one place that
 * decides whether a holder — a person in the editor or an agent session —
 * may change some top-level blocks of a document. Humans (their commits,
 * in the sync worker) and agents (the write gate, in the sync worker)
 * call the same `decideLease`; nothing else decides.
 *
 * Pure: no git, no clock of its own, no I/O. The caller hands it the
 * document's current leases already mapped onto the document version the
 * change is made against (`merge/blocks.ts` alignment, the same block
 * identity the merge and cursor anchors use), each marked stale or not by
 * the local client's own observation of its ref (decision 7).
 *
 * The rules:
 *
 * - **All or nothing.** A change takes every block it needs, or none.
 * - **Others' live leases refuse.** Any needed block another holder leases
 *   (and that lease is live) refuses the whole change, naming the holders.
 * - **Takeover only after staleness.** A lease whose ref this client has
 *   not seen move for `LEASE_STALE_MS` no longer refuses; the change takes
 *   its blocks, and the caller deletes that ref (CAS) in the same push.
 * - **Structural changes need their neighbours.** Inserting, deleting or
 *   moving blocks needs the leases on the blocks either side of the
 *   stretch (`withNeighbours`): an insert next to a block someone is
 *   editing would make that block's identity ambiguous to the alignment.
 * - **A cap per holder.** At most `LEASE_MAX_BLOCKS` blocks per holder per
 *   document, counting what it already holds.
 * - **Idle expiry.** A holder lets go of a block it hasn't touched for
 *   `LEASE_IDLE_MS` (`releaseIdle`), and of everything when it is done
 *   (an agent's turn ends, the workspace closes, the level leaves shared).
 */

/** A holder may lease at most this many blocks of one document. */
export const LEASE_MAX_BLOCKS = 20;
/** A holder releases a block it hasn't touched for this long. */
export const LEASE_IDLE_MS = 20_000;
/** A holder re-publishes a lease it still holds this often, so others
 *  keep seeing its ref move. */
export const LEASE_RENEW_MS = 8_000;
/**
 * Another client treats a lease as stale (and may take it over) once its
 * ref hasn't moved for this long by that client's own clock. It must
 * outlast a renewal plus a slow shared poll and a slow push.
 */
export const LEASE_STALE_MS = 30_000;

export type LeaseHolderKind = "human" | "agent";

/** Who holds a lease: a person (`id` = their device id) or one of their
 *  agent sessions (`id` = `<deviceId>/<taskId>`). */
export interface LeaseHolder {
  id: string;
  kind: LeaseHolderKind;
  deviceId: string;
  /** The person's name (an agent carries its person's). */
  name: string;
  color: string;
  taskId?: string;
  harness?: string;
}

/** One holder's lease on a document, mapped onto the version the change
 *  is made against. */
export interface CurrentLease {
  holder: LeaseHolder;
  /** Block indexes in that version. */
  blocks: readonly number[];
  /** Its ref hasn't been seen to move for `LEASE_STALE_MS`. */
  stale: boolean;
}

export type LeaseDecision =
  | {
      granted: true;
      /** What the holder will hold here: what it held plus `needed`. */
      blocks: number[];
      /** Stale leases of others the change takes blocks from: their refs
       *  are deleted in the same push. */
      takeovers: CurrentLease[];
    }
  | {
      granted: false;
      reason: "held" | "cap";
      /** Who holds the blocks that refused ("held"), or the holder itself
       *  ("cap"). */
      holders: LeaseHolder[];
      /** The needed blocks that refused. */
      blocks: number[];
    };

const sorted = (blocks: Iterable<number>) => [...new Set(blocks)].sort((a, b) => a - b);

/**
 * `blocks` plus the block on each side of the stretch they cover: what a
 * structural change (insert, delete, move) needs. `gaps` are insert
 * positions (an insert before block `g`) with no block of their own.
 * Clipped to `[0, length)`.
 */
export function withNeighbours(
  blocks: readonly number[],
  length: number,
  gaps: readonly number[] = [],
): number[] {
  const out = new Set(blocks);
  for (const block of blocks) {
    out.add(block - 1);
    out.add(block + 1);
  }
  for (const gap of gaps) {
    out.add(gap - 1);
    out.add(gap);
  }
  return sorted([...out].filter((block) => block >= 0 && block < length));
}

/**
 * Decide whether `holder` may make a change needing `needed` (block
 * indexes of the version the leases are mapped onto). The one rule for
 * humans and agents.
 */
export function decideLease(input: {
  holder: LeaseHolder;
  needed: readonly number[];
  leases: readonly CurrentLease[];
  cap?: number;
}): LeaseDecision {
  const { holder, leases } = input;
  const cap = input.cap ?? LEASE_MAX_BLOCKS;
  const needed = sorted(input.needed);
  const own = new Set(
    leases.filter((lease) => lease.holder.id === holder.id).flatMap((lease) => lease.blocks),
  );
  const others = leases.filter((lease) => lease.holder.id !== holder.id);
  const blocking = others.filter(
    (lease) => !lease.stale && lease.blocks.some((block) => needed.includes(block)),
  );
  if (blocking.length > 0) {
    const refused = new Set(blocking.flatMap((lease) => lease.blocks));
    return {
      granted: false,
      reason: "held",
      holders: uniqueHolders(blocking.map((lease) => lease.holder)),
      blocks: needed.filter((block) => refused.has(block)),
    };
  }
  const blocks = sorted([...own, ...needed]);
  if (blocks.length > cap) {
    return { granted: false, reason: "cap", holders: [holder], blocks: needed };
  }
  const takeovers = others.filter(
    (lease) => lease.stale && lease.blocks.some((block) => needed.includes(block)),
  );
  return { granted: true, blocks, takeovers };
}

function uniqueHolders(holders: LeaseHolder[]): LeaseHolder[] {
  const seen = new Map<string, LeaseHolder>();
  for (const holder of holders) if (!seen.has(holder.id)) seen.set(holder.id, holder);
  return [...seen.values()];
}

/** The blocks a holder keeps: those touched within `LEASE_IDLE_MS`. */
export function releaseIdle<T extends { touchedAt: number }>(
  blocks: readonly T[],
  now: number,
  idleMs = LEASE_IDLE_MS,
): T[] {
  return blocks.filter((block) => now - block.touchedAt < idleMs);
}

/** A lease is stale when its ref hasn't been seen to move for
 *  `LEASE_STALE_MS` (by the local clock); `changedAt` null: never seen. */
export function isLeaseStale(changedAt: number | null, now: number, staleMs = LEASE_STALE_MS) {
  return changedAt === null || now - changedAt >= staleMs;
}

// --- What a change needs ----------------------------------------------------

/**
 * One stretch of a change between two versions of a document: blocks
 * `[fromStart, fromEnd)` of the old version became `[toStart, toEnd)` of
 * the new one. Blocks the alignment matched sit between stretches.
 */
export interface ChangeStretch {
  fromStart: number;
  fromEnd: number;
  toStart: number;
  toEnd: number;
}

/** What a change needs (old indexes) and what its holder then holds (new
 *  indexes), for one or more stretches. */
export interface LeaseChange {
  /** Blocks of the old version the change needs leases on. */
  needed: number[];
  /** Blocks of the new version the holder will lease. */
  result: number[];
}

/** A stretch that adds or removes blocks is structural: it needs its
 *  neighbours. A same-count stretch is an edit of those blocks. */
export function stretchNeeds(
  stretch: ChangeStretch,
  fromLength: number,
  toLength: number,
): LeaseChange {
  const range = (start: number, end: number) =>
    Array.from({ length: end - start }, (_, i) => start + i);
  const from = range(stretch.fromStart, stretch.fromEnd);
  const to = range(stretch.toStart, stretch.toEnd);
  if (from.length === to.length) return { needed: from, result: to };
  return {
    needed: withNeighbours(from, fromLength, from.length === 0 ? [stretch.fromStart] : []),
    result: withNeighbours(to, toLength, to.length === 0 ? [stretch.toStart] : []),
  };
}

/**
 * The stretches between two versions, from an alignment (`alignBlocks`
 * (from, to)`: each old index → its identical new index, or -1).
 */
export function changeStretches(
  alignment: readonly number[],
  toLength: number,
): ChangeStretch[] {
  const out: ChangeStretch[] = [];
  let fromStart = 0;
  let toStart = 0;
  const close = (fromEnd: number, toEnd: number) => {
    if (fromEnd > fromStart || toEnd > toStart) {
      out.push({ fromStart, fromEnd, toStart, toEnd });
    }
  };
  for (let i = 0; i < alignment.length; i++) {
    const j = alignment[i];
    if (j < 0) continue;
    close(i, j);
    fromStart = i + 1;
    toStart = j + 1;
  }
  close(alignment.length, toLength);
  return out;
}

/** What a whole change needs: the union of its stretches. */
export function changeNeeds(
  stretches: readonly ChangeStretch[],
  fromLength: number,
  toLength: number,
): LeaseChange {
  const needed = new Set<number>();
  const result = new Set<number>();
  for (const stretch of stretches) {
    const one = stretchNeeds(stretch, fromLength, toLength);
    one.needed.forEach((block) => needed.add(block));
    one.result.forEach((block) => result.add(block));
  }
  return { needed: sorted(needed), result: sorted(result) };
}

/** A short, human list of block numbers (1-based): "3", "3 and 5",
 *  "2–4". */
export function describeBlocks(blocks: readonly number[]): string {
  const list = sorted(blocks).map((block) => block + 1);
  if (list.length === 0) return "";
  const runs: string[] = [];
  let start = list[0];
  let prev = list[0];
  for (const block of [...list.slice(1), Number.NaN]) {
    if (block === prev + 1) {
      prev = block;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = block;
  }
  return runs.length === 1 ? runs[0] : `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}`;
}

/** "Ada", "Ada's claude agent". */
export function holderLabel(holder: LeaseHolder): string {
  return holder.kind === "agent"
    ? `${holder.name}'s ${holder.harness ?? "agent"} agent`
    : holder.name;
}
