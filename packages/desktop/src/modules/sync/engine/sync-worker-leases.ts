/**
 * Leases in the sync worker (MET-273): reading lease refs and mapping
 * their blocks onto the branch head, the merge's per-block holder, the
 * lease rule over what a push changes (acquisitions ride in the same
 * atomic push as the branch CAS), renewals and releases (a request of
 * their own), and the rule for an agent's write before it happens.
 *
 * All block work happens here, off the main thread, with the alignment
 * the merge uses (`worker-blocks.ts`). The rule itself is
 * `lease-rules.ts`: humans and agents both go through `decideLease`.
 */
import { GitError, ZERO_OID, type GitRefUpdate, type GitRemote } from "@notefig/git";
import type { BlockHolder, BlockSpan } from "../merge/merge";
import { alignBlocks, mapBlockIndexWith } from "../merge/blocks";
import {
  changeNeeds,
  changeStretches,
  decideLease,
  type ChangeStretch,
  type CurrentLease,
  type LeaseHolder,
} from "../lease-rules";
import type {
  SyncAcquireInput,
  SyncLeaseGrant,
  SyncLeasePayload,
  SyncLeasePublishOutcome,
  SyncLeasePushResult,
  SyncLeaseRead,
  SyncLeaseRefusal,
  SyncRefTip,
  SyncWritePlan,
} from "../sync-types";
import {
  alignCached,
  blocksAt,
  cachedBlocks,
  indexMapper,
  type BlockContext,
} from "./worker-blocks";
import { decodeLease, docIdOf, encodeLease, LEASE_FORMAT_VERSION, lockRef } from "./lease-payload";
import { isMarkdownPath } from "./sync-merge-driver";

/** One lease ref the worker knows, as last read. */
export interface LeaseEntry {
  ref: string;
  oid: string;
  live: boolean;
  payload: SyncLeasePayload;
}

/** The worker's lease table: set by each `readLeases`. */
export interface LeaseTable {
  self: string | null;
  entries: LeaseEntry[];
  /** Decoded payloads by blob oid (null: not a lease). */
  decoded: Map<string, SyncLeasePayload | null>;
}

export function createLeaseTable(): LeaseTable {
  return { self: null, entries: [], decoded: new Map() };
}

export interface LeaseContext extends BlockContext {
  remote: GitRemote;
  head(): Promise<string | null>;
  table: LeaseTable;
}

const DECODED_LIMIT = 256;

async function decodedPayload(ctx: LeaseContext, tip: SyncRefTip) {
  const key = `${tip.ref}@${tip.oid}`;
  if (ctx.table.decoded.has(key)) return ctx.table.decoded.get(key)!;
  const bytes = await ctx.service.readBlob(tip.oid).catch(() => null);
  const payload = bytes ? await decodeLease(bytes, tip.ref) : null;
  ctx.table.decoded.set(key, payload);
  if (ctx.table.decoded.size > DECODED_LIMIT) {
    ctx.table.decoded.delete(ctx.table.decoded.keys().next().value!);
  }
  return payload;
}

/** Fetch the blobs not here yet (one request), decode, keep as the table,
 *  and map each lease's blocks onto the head. */
export async function readLeases(
  ctx: LeaseContext,
  input: { refs: Array<SyncRefTip & { live: boolean }>; self: string },
): Promise<SyncLeaseRead[]> {
  ctx.table.self = input.self;
  if (input.refs.length === 0) {
    ctx.table.entries = [];
    return [];
  }
  const missing: SyncRefTip[] = [];
  for (const tip of input.refs) {
    const known = ctx.table.decoded.has(`${tip.ref}@${tip.oid}`);
    if (!known && !(await ctx.service.readBlob(tip.oid).then(() => true, () => false))) {
      missing.push({ ref: tip.ref, oid: tip.oid });
    }
  }
  if (missing.length > 0) await ctx.service.fetchRefs(ctx.remote, missing, { haves: [] });
  const head = await ctx.head();
  const entries: LeaseEntry[] = [];
  const out: SyncLeaseRead[] = [];
  for (const tip of input.refs) {
    const payload = await decodedPayload(ctx, tip);
    if (!payload) {
      out.push({ ...tip, payload: null, mapped: [] });
      continue;
    }
    entries.push({ ref: tip.ref, oid: tip.oid, live: tip.live, payload });
    const map = await indexMapper(ctx, payload.path, payload.commit, head);
    out.push({ ...tip, payload, mapped: payload.blocks.map(map) });
  }
  ctx.table.entries = entries;
  return out;
}

/** Load the block splits the holder function reads synchronously (a
 *  lease's commit may only now be fetched). Before every merge. */
export async function prepareLeaseBlocks(ctx: LeaseContext): Promise<void> {
  for (const entry of ctx.table.entries) {
    if (entry.live) await blocksAt(ctx, entry.payload.commit, entry.payload.path);
  }
}

/** The base blocks a lease covers: its blocks at its commit, aligned onto
 *  the merge's base. A commit not here maps as-is. */
function blocksOnBase(ctx: LeaseContext, entry: LeaseEntry, base: readonly string[]): number[] {
  const source = cachedBlocks(ctx.cache, entry.payload.commit, entry.payload.path);
  if (!source) return entry.payload.blocks;
  const map = alignBlocks(source, [...base]);
  return entry.payload.blocks
    .map((block) => mapBlockIndexWith(map, base.length, block))
    .filter((block): block is number => block !== null);
}

const covers = (blocks: number[], span: BlockSpan) =>
  span.start === span.end
    ? blocks.some((block) => block === span.start - 1 || block === span.start)
    : blocks.some((block) => block >= span.start && block < span.end);

/**
 * Who wins each overlap in `path` (decision 10, holder wins): a run of
 * base blocks a live lease of one of this device's holders covers goes to
 * the local side ("ours"), one another device's lease covers to the
 * remote's ("theirs", which also wins when both claim it: the branch
 * ordered that lease first). Null when nobody leases the document: the
 * merge's default.
 */
export function holderFor(ctx: LeaseContext, path: string): BlockHolder | null {
  const entries = ctx.table.entries.filter((entry) => entry.live && entry.payload.path === path);
  if (entries.length === 0) return null;
  const self = ctx.table.self;
  return (span) => {
    let ours = false;
    for (const entry of entries) {
      if (!covers(blocksOnBase(ctx, entry, span.base), span)) continue;
      if (entry.payload.holder.deviceId !== self) return "theirs";
      ours = true;
    }
    return ours ? "ours" : "theirs";
  };
}

/** The table's leases on `path`, mapped onto `commit`. */
async function leasesAt(ctx: LeaseContext, path: string, commit: string) {
  const out: Array<CurrentLease & { entry: LeaseEntry }> = [];
  for (const entry of ctx.table.entries) {
    if (entry.payload.path !== path) continue;
    const map = await indexMapper(ctx, path, entry.payload.commit, commit);
    const blocks = entry.payload.blocks
      .map(map)
      .filter((block): block is number => block !== null);
    out.push({ holder: entry.payload.holder, blocks, stale: !entry.live, entry });
  }
  return out;
}

/** The new indexes of `to` an agent's written text covers. */
function claimedBlocks(content: string[], to: string[]): Set<number> {
  const map = alignBlocks(content, to);
  return new Set(map.filter((index) => index >= 0));
}

const stretchTouches = (stretch: ChangeStretch, blocks: Set<number>) => {
  if (stretch.toEnd === stretch.toStart) {
    return blocks.has(stretch.toStart - 1) || blocks.has(stretch.toStart);
  }
  for (let i = stretch.toStart; i < stretch.toEnd; i++) if (blocks.has(i)) return true;
  return false;
};

/** Who each changed stretch belongs to: the agent whose written text
 *  covers it, else the person. */
function attribute(
  stretches: ChangeStretch[],
  human: LeaseHolder,
  claims: Array<{ holder: LeaseHolder; blocks: Set<number> }>,
) {
  const groups = new Map<string, { holder: LeaseHolder; stretches: ChangeStretch[] }>();
  for (const stretch of stretches) {
    const owner = claims.find((claim) => stretchTouches(stretch, claim.blocks))?.holder ?? human;
    const group = groups.get(owner.id) ?? { holder: owner, stretches: [] };
    group.stretches.push(stretch);
    groups.set(owner.id, group);
  }
  return [...groups.values()];
}

interface Plan {
  updates: GitRefUpdate[];
  result: SyncLeasePushResult;
}

/** One holder's lease on one document after a granted change. */
async function grantFor(
  ctx: LeaseContext,
  input: {
    holder: LeaseHolder;
    path: string;
    head: string;
    own: (CurrentLease & { entry: LeaseEntry }) | undefined;
    toRemote: Array<number | null>;
    alignment: number[];
    toLength: number;
    result: number[];
    takeovers: Array<CurrentLease & { entry: LeaseEntry }>;
  },
): Promise<{ grant: SyncLeaseGrant; updates: GitRefUpdate[] }> {
  const { holder, path, head, own } = input;
  const byBlock = new Map<number, number | null>();
  own?.entry.payload.blocks.forEach((_, k) => {
    const atRemote = input.toRemote[k];
    if (atRemote === null || atRemote === undefined) return;
    const atHead = mapBlockIndexWith(input.alignment, input.toLength, atRemote);
    if (atHead !== null) byBlock.set(atHead, k);
  });
  for (const block of input.result) if (!byBlock.has(block)) byBlock.set(block, null);
  const blocks = [...byBlock.keys()].sort((a, b) => a - b);
  const touched = new Set(input.result);
  const payload: SyncLeasePayload = {
    v: LEASE_FORMAT_VERSION,
    holder,
    path,
    commit: head,
    seq: (own?.entry.payload.seq ?? 0) + 1,
    blocks,
  };
  const oid = await ctx.service.writeBlob(encodeLease(payload));
  const ref = lockRef(await docIdOf(path), holder.id);
  const updates: GitRefUpdate[] = [{ ref, old: own?.entry.oid ?? ZERO_OID, new: oid }];
  for (const stale of input.takeovers) {
    updates.push({ ref: stale.entry.ref, old: stale.entry.oid, new: ZERO_OID });
  }
  return {
    grant: {
      holder,
      path,
      ref,
      oid,
      payload,
      prev: blocks.map((block) => byBlock.get(block) ?? null),
      touched: blocks.map((block) => touched.has(block)),
      tookOver: input.takeovers.map((stale) => stale.holder),
    },
    updates,
  };
}

/** The lease rule over one changed document. */
async function planDocument(
  ctx: LeaseContext,
  input: { path: string; from: string | undefined; remote: string; head: string },
  acquire: SyncAcquireInput,
  plan: Plan,
): Promise<void> {
  const { path, remote, head } = input;
  const to = await blocksAt(ctx, head, path);
  if (!to) return;
  const from = input.from ? ((await blocksAt(ctx, remote, path)) ?? []) : [];
  const alignment = alignCached(ctx.cache, `${remote}:${head}:${path}`, from, to);
  const stretches = changeStretches(alignment, to.length);
  if (stretches.length === 0) return;
  const split = await ctx.loadBlocks();
  const claims = acquire.agents
    .filter((claim) => claim.path === path)
    .map((claim) => ({ holder: claim.holder, blocks: claimedBlocks(split(claim.content), to) }));
  const leases = await leasesAt(ctx, path, remote);
  for (const group of attribute(stretches, acquire.human, claims)) {
    const { needed, result } = changeNeeds(group.stretches, from.length, to.length);
    const decision = decideLease({ holder: group.holder, needed, leases });
    if (!decision.granted) {
      plan.result.refusals.push({
        holder: group.holder,
        path,
        reason: decision.reason,
        holders: decision.holders,
        blocks: decision.blocks,
      } satisfies SyncLeaseRefusal);
      continue;
    }
    const own = leases.find((lease) => lease.holder.id === group.holder.id);
    const toRemote = own
      ? await Promise.all(
          own.entry.payload.blocks.map(async (block) =>
            (await indexMapper(ctx, path, own.entry.payload.commit, remote))(block),
          ),
        )
      : [];
    const takeovers = leases.filter((lease) => decision.takeovers.some((t) => t.holder.id === lease.holder.id));
    const { grant, updates } = await grantFor(ctx, {
      holder: group.holder,
      path,
      head,
      own,
      toRemote,
      alignment,
      toLength: to.length,
      result,
      takeovers,
    });
    plan.result.grants.push(grant);
    for (const update of updates) {
      if (!plan.updates.some((known) => known.ref === update.ref)) plan.updates.push(update);
    }
  }
}

/**
 * The leases a push of `remote..head` takes: per changed markdown file,
 * each changed stretch is the person's or the agent's whose write covers
 * it, and each holder's needs go through the lease rule, all or nothing.
 * Returns the ref updates to add to the branch's atomic push.
 */
export async function planAcquisitions(
  ctx: LeaseContext,
  input: { remote: string; head: string; acquire: SyncAcquireInput },
): Promise<Plan> {
  const plan: Plan = { updates: [], result: { grants: [], refusals: [] } };
  const changes = await ctx.service.changedFiles(input.remote, input.head);
  for (const change of changes) {
    if (!change.to || !isMarkdownPath(change.path)) continue;
    await planDocument(
      ctx,
      { path: change.path, from: change.from, remote: input.remote, head: input.head },
      input.acquire,
      plan,
    );
  }
  return plan;
}

/** Renew or release this device's own leases: one atomic request of lease
 *  refs only. */
export async function publishLeases(
  ctx: LeaseContext,
  input: { updates: Array<{ ref: string; old: string | null; payload: SyncLeasePayload | null }> },
): Promise<SyncLeasePublishOutcome> {
  const oids: Record<string, string | null> = {};
  const updates: GitRefUpdate[] = [];
  for (const update of input.updates) {
    const next = update.payload ? await ctx.service.writeBlob(encodeLease(update.payload)) : ZERO_OID;
    oids[update.ref] = update.payload ? next : null;
    if (next === (update.old ?? ZERO_OID)) continue;
    updates.push({ ref: update.ref, old: update.old ?? ZERO_OID, new: next });
  }
  if (updates.length === 0) return { status: "published", oids };
  try {
    const result = await ctx.service.pushRefs(ctx.remote, updates, {
      atomic: updates.length > 1,
    });
    return result.ok ? { status: "published", oids } : { status: "rejected" };
  } catch (error) {
    if (error instanceof GitError && error.code === "PushOutcomeUnknown") return { status: "unknown" };
    throw error;
  }
}

/**
 * The rule for a write before it happens (the agent gate): what `content`
 * changes against `current`, checked against the table's leases mapped
 * onto `current` (head → current: the editor may hold unsaved text).
 */
export async function planWrite(
  ctx: LeaseContext,
  input: { path: string; current: string; content: string; holder: LeaseHolder },
): Promise<SyncWritePlan> {
  const split = await ctx.loadBlocks();
  const current = split(input.current);
  const next = split(input.content);
  const { needed } = changeNeeds(changeStretches(alignBlocks(current, next), next.length), current.length, next.length);
  if (needed.length === 0) return { granted: true, needed };
  const head = await ctx.head();
  const atHead = head ? await leasesAt(ctx, input.path, head) : [];
  const headBlocks = head ? await blocksAt(ctx, head, input.path) : null;
  const toCurrent = headBlocks ? alignBlocks(headBlocks, current) : null;
  const leases: CurrentLease[] = atHead.map((lease) => ({
    holder: lease.holder,
    stale: lease.stale,
    blocks: toCurrent
      ? lease.blocks
          .map((block) => mapBlockIndexWith(toCurrent, current.length, block))
          .filter((block): block is number => block !== null)
      : lease.blocks,
  }));
  const decision = decideLease({ holder: input.holder, needed, leases });
  if (decision.granted) return { granted: true, needed };
  return { granted: false, reason: decision.reason, holders: decision.holders, blocks: decision.blocks };
}
