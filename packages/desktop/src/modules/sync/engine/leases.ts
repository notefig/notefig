/**
 * Leases, the main thread's side (MET-273), part of the sync engine
 * (loaded only for a sync workspace; active only at the shared level). It
 * decides *when*; the worker reads, maps and writes lease refs, and runs
 * the lease rule (`sync-worker-leases.ts`, `lease-rules.ts`).
 *
 * Within the engine's cycle:
 *
 * 1. after each poll, `observe(tips)`: each lease ref's liveness by local
 *    observation (a ref this client has seen standing still for
 *    `LEASE_STALE_MS` is stale and may be taken over; a ref first seen on
 *    this client's first poll counts as moving then, so a lease is never
 *    taken over before this client watched it go quiet), then the worker
 *    reads them into its lease table (the merge's holder, the push's rule);
 * 2. the push carries `acquireInput()`: this device's person, plus any
 *    agent writes waiting for their leases (`claim`). The worker attributes
 *    each changed stretch to its writer and takes the leases the rule
 *    grants in the same atomic push as the branch; `pushed` applies them;
 * 3. after the cycle, `step(head)`: blocks a holder hasn't touched for
 *    `LEASE_IDLE_MS` are released, held ones renewed every
 *    `LEASE_RENEW_MS` (one request of lease refs only), and each open
 *    document's channel gets its lease view (`leases`, latest value,
 *    only on change), which the editor draws and makes read-only.
 *
 * Holder ids line up with presence: a person is their device id, an agent
 * `<deviceId>/<taskId>`.
 */
import type { Hooks } from "@notefig/core";
import { path as pathutil } from "@/utils/path";
import type { SyncDocumentPort, SyncLeaseOutcome, SyncLeaseView } from "../document-channel";
import {
  LEASE_IDLE_MS,
  LEASE_RENEW_MS,
  isLeaseStale,
  type LeaseHolder,
} from "../lease-rules";
import type { SyncCapabilities } from "../sync-machine";
import type {
  SyncAcquireInput,
  SyncAgentClaim,
  SyncLease,
  SyncLeasePayload,
  SyncLeasePushResult,
  SyncLeaseRead,
  SyncLeaseRefusal,
  SyncRefTip,
  SyncWorkerApi,
} from "../sync-types";
import { holderSegment, parseLockRef } from "./lease-payload";

/** How long a goodbye (releasing every lease) may hold up closing. */
const LEASE_GOODBYE_TIMEOUT_MS = 2_000;

export interface LeasesDeps {
  workspacePath: string;
  deviceId: string;
  api: Pick<SyncWorkerApi, "readLeases" | "publishLeases">;
  hooks: Hooks;
  identity(): { name: string; color: string };
  capabilities(): SyncCapabilities;
  ports(): SyncDocumentPort[];
  /** The leases changed (the module's list, the presence list's holds). */
  leasesChanged(leases: readonly SyncLease[]): void;
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
}

/** One of this device's own leases. `touchedAt[i]` is when the holder
 *  last changed `payload.blocks[i]`. */
interface OwnLease {
  ref: string;
  oid: string;
  payload: SyncLeasePayload;
  touchedAt: number[];
  publishedAt: number;
}

/** What an agent's write got. */
export type ClaimOutcome =
  | { status: "granted" }
  | { status: "refused"; refusal: SyncLeaseRefusal }
  /** It wasn't pushed (offline, or nothing changed). */
  | { status: "unsynced" };

interface PendingClaim extends SyncAgentClaim {
  outcome: ClaimOutcome | null;
}

export interface Leases {
  start(): void;
  /** This device's person as a holder. */
  human(): LeaseHolder;
  agentHolder(taskId: string, harness: string): LeaseHolder;
  /** After a poll (shared only): liveness, then the worker's table. */
  observe(tips: readonly SyncRefTip[]): Promise<void>;
  /** What the next push asks for; undefined below shared. */
  acquireInput(): SyncAcquireInput | undefined;
  /** A push landed with these acquisitions. */
  pushed(result: SyncLeasePushResult | undefined): void;
  /** After the cycle: remap, release idle, renew, views. Never throws. */
  step(head: string | null): Promise<void>;
  /** An agent write waiting for its lease in the next push. */
  claim(claim: SyncAgentClaim): { outcome(): ClaimOutcome; drop(): void };
  /** Whether `blocks` (head indexes) of `path` are free of others' live
   *  leases (the channel's `requestLease`). */
  check(path: string, blocks: number[]): SyncLeaseOutcome;
  /** How many blocks a device's holders lease: in all, and per agent. */
  holdsOf(deviceId: string): { total: number; agents: Record<string, number> };
  /** Release every lease (bounded; best effort). */
  goodbye(): Promise<void>;
  stop(): void;
}

export function createLeases(deps: LeasesDeps): Leases {
  const root = pathutil.normalize(deps.workspacePath);
  const ownSegment = holderSegment(deps.deviceId);
  const ownAgentPrefix = holderSegment(`${deps.deviceId}/`);
  /** ref → when this client saw it move (null: never seen). */
  const seen = new Map<string, { oid: string; changedAt: number }>();
  const own = new Map<string, OwnLease>();
  const claims: PendingClaim[] = [];
  let tips: SyncRefTip[] = [];
  let reads: SyncLeaseRead[] = [];
  let readHead: string | null | undefined;
  let listKey = "[]";
  let list: SyncLease[] = [];
  /** Holders' payload sizes as last announced (ref → blocks). */
  let announced = new Map<string, { holder: LeaseHolder; path: string; blocks: number }>();
  const portKeys = new WeakMap<SyncDocumentPort, string>();
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const absolute = (tree: string) => pathutil.join(root, pathutil.fromTreePath(tree));
  const isOwnRef = (ref: string) => {
    const segment = parseLockRef(ref)?.segment;
    return segment === ownSegment || (segment?.startsWith(ownAgentPrefix) ?? false);
  };

  const human = (): LeaseHolder => ({
    id: deps.deviceId,
    kind: "human",
    deviceId: deps.deviceId,
    ...deps.identity(),
  });

  const agentHolder = (taskId: string, harness: string): LeaseHolder => ({
    id: `${deps.deviceId}/${taskId}`,
    kind: "agent",
    deviceId: deps.deviceId,
    ...deps.identity(),
    taskId,
    harness,
  });

  const live = (ref: string) => {
    if (isOwnRef(ref)) return true;
    return !isLeaseStale(seen.get(ref)?.changedAt ?? null, deps.now());
  };

  const watch = (next: readonly SyncRefTip[]) => {
    const at = deps.now();
    const present = new Set(next.map((tip) => tip.ref));
    for (const tip of next) {
      const prior = seen.get(tip.ref);
      if (!prior || prior.oid !== tip.oid) seen.set(tip.ref, { oid: tip.oid, changedAt: at });
    }
    for (const ref of [...seen.keys()]) if (!present.has(ref)) seen.delete(ref);
  };

  /** The refs as this device knows them: the poll's, with its own refs as
   *  it last wrote them. */
  const effectiveTips = (): SyncRefTip[] => [
    ...tips.filter((tip) => !isOwnRef(tip.ref)),
    ...[...own.values()].map(({ ref, oid }) => ({ ref, oid })),
  ];

  const read = async (head: string | null) => {
    const refs = effectiveTips().map((tip) => ({ ...tip, live: live(tip.ref) }));
    const result = await deps.api.readLeases({ refs, self: deps.deviceId });
    if (!result.ok) return;
    reads = result.value;
    readHead = head;
  };

  /** The poll's view of this device's own refs wins: one it doesn't know
   *  (left over from an earlier run) is adopted to be released; one that
   *  is gone (taken over) is dropped. */
  const adoptOwn = (polled: SyncLeaseRead[]) => {
    const polledOwn = new Map(polled.filter((r) => isOwnRef(r.ref) && r.payload).map((r) => [r.ref, r]));
    for (const ref of [...own.keys()]) {
      if (!polledOwn.has(ref)) own.delete(ref);
    }
    for (const [ref, found] of polledOwn) {
      const known = own.get(ref);
      if (known?.oid === found.oid) continue;
      const payload = found.payload!;
      own.set(ref, {
        ref,
        oid: found.oid,
        payload,
        // Left over from an earlier run: idle at once.
        touchedAt: payload.blocks.map((_, i) => known?.touchedAt[i] ?? 0),
        publishedAt: known?.publishedAt ?? 0,
      });
    }
  };

  const announceReleased = (holder: LeaseHolder, path: string, count: number) => {
    if (count <= 0) return;
    deps.hooks.emit("sync:lease-released", {
      workspacePath: root,
      holder,
      path: absolute(path),
      blocks: count,
      local: holder.deviceId === deps.deviceId,
    });
  };

  /** Announce holders whose leases grew (acquired) or shrank or went
   *  (released), people and agents, here and on other devices. */
  const announce = () => {
    const next = new Map<string, { holder: LeaseHolder; path: string; blocks: number }>();
    for (const r of reads) {
      if (!r.payload || !r.live) continue;
      next.set(r.ref, { holder: r.payload.holder, path: r.payload.path, blocks: r.payload.blocks.length });
    }
    for (const [ref, now] of next) {
      const before = announced.get(ref)?.blocks ?? 0;
      if (now.blocks > before) {
        deps.hooks.emit("sync:lease-acquired", {
          workspacePath: root,
          holder: now.holder,
          path: absolute(now.path),
          blocks: now.blocks,
          local: now.holder.deviceId === deps.deviceId,
        });
      } else if (now.blocks < before) {
        announceReleased(now.holder, now.path, before - now.blocks);
      }
    }
    for (const [ref, before] of announced) {
      if (!next.has(ref)) announceReleased(before.holder, before.path, before.blocks);
    }
    announced = next;
  };

  /** The live leases on the head, as the app shows them. */
  const leaseList = (): SyncLease[] =>
    reads.flatMap((r) => {
      if (!r.payload || !r.live) return [];
      const blocks = r.mapped.filter((block): block is number => block !== null);
      if (blocks.length === 0) return [];
      return [
        {
          holder: r.payload.holder,
          path: absolute(r.payload.path),
          blocks,
          mine: r.payload.holder.deviceId === deps.deviceId,
        },
      ];
    });

  const viewsFor = (path: string): SyncLeaseView[] =>
    list
      .filter((lease) => lease.path === path)
      .flatMap((lease) =>
        lease.blocks.map((blockIndex) => ({
          blockIndex,
          holderId: lease.holder.id,
          name: lease.holder.name,
          color: lease.holder.color,
          mine: lease.mine,
          kind: lease.holder.kind,
          ...(lease.holder.harness ? { harness: lease.holder.harness } : {}),
        })),
      )
      .sort((a, b) => a.blockIndex - b.blockIndex);

  const deliver = () => {
    const next = leaseList();
    const key = JSON.stringify(next);
    if (key !== listKey) {
      listKey = key;
      list = next;
      deps.leasesChanged(list);
    }
    for (const port of deps.ports()) {
      if (port.closed) continue;
      const views = viewsFor(port.channel.path);
      const portKey = JSON.stringify(views);
      if (portKeys.get(port) === portKey) continue;
      portKeys.set(port, portKey);
      port.leases.set(views);
    }
  };

  /** Renewals and releases due now, as one request. */
  const dueUpdates = () => {
    const now = deps.now();
    const updates: Array<{ ref: string; old: string | null; payload: SyncLeasePayload | null; keep: number[] }> = [];
    for (const lease of own.values()) {
      const keep = lease.touchedAt
        .map((at, i) => (now - at < LEASE_IDLE_MS ? i : -1))
        .filter((i) => i >= 0);
      if (keep.length === 0) {
        updates.push({ ref: lease.ref, old: lease.oid, payload: null, keep });
      } else if (keep.length < lease.payload.blocks.length || now - lease.publishedAt >= LEASE_RENEW_MS) {
        // Indexes stay relative to the payload's own commit: others map
        // them from there, so a renewal never needs to re-map.
        const payload = {
          ...lease.payload,
          seq: lease.payload.seq + 1,
          blocks: keep.map((i) => lease.payload.blocks[i]),
        };
        updates.push({ ref: lease.ref, old: lease.oid, payload, keep });
      }
    }
    return updates;
  };

  const publish = async (updates: ReturnType<typeof dueUpdates>) => {
    if (updates.length === 0) return;
    const result = await deps.api.publishLeases({
      updates: updates.map(({ ref, old, payload }) => ({ ref, old, payload })),
    });
    if (!result.ok || result.value.status !== "published") return;
    const now = deps.now();
    for (const update of updates) {
      const lease = own.get(update.ref);
      if (!lease) continue;
      if (!update.payload) {
        own.delete(update.ref);
      } else {
        own.set(update.ref, {
          ...lease,
          oid: result.value.oids[update.ref] ?? lease.oid,
          payload: update.payload,
          touchedAt: update.keep.map((i) => lease.touchedAt[i]),
          publishedAt: now,
        });
      }
    }
  };

  /** Below shared there are no leases: let go of everything. */
  const leaveShared = async () => {
    if (own.size > 0) {
      await publish(
        [...own.values()].map((lease) => ({ ref: lease.ref, old: lease.oid, payload: null, keep: [] })),
      );
    }
    if (reads.length > 0 || readHead !== undefined) {
      reads = [];
      readHead = undefined;
      tips = [];
      await deps.api.readLeases({ refs: [], self: deps.deviceId });
    }
    announce();
    deliver();
  };

  const settle = (claim: PendingClaim, outcome: ClaimOutcome) => {
    if (!claim.outcome) claim.outcome = outcome;
  };

  return {
    start() {
      unsubscribe = deps.hooks.on("agent:turn-settled", ({ taskId }) => {
        // Release when done: the agent's blocks go idle at once.
        for (const lease of own.values()) {
          if (lease.payload.holder.taskId === taskId) lease.touchedAt = lease.touchedAt.map(() => 0);
        }
      });
    },
    human,
    agentHolder,
    async observe(next) {
      if (stopped || !deps.capabilities().leases) return;
      watch(next);
      tips = [...next];
      const result = await deps.api.readLeases({
        refs: next.map((tip) => ({ ...tip, live: live(tip.ref) })),
        self: deps.deviceId,
      });
      if (!result.ok) return;
      adoptOwn(result.value);
      reads = result.value;
      readHead = undefined;
    },
    acquireInput() {
      if (stopped || !deps.capabilities().leases) return undefined;
      return {
        human: human(),
        agents: claims.map(({ holder, path, content }) => ({ holder, path, content })),
      };
    },
    pushed(result) {
      if (!result) return;
      const now = deps.now();
      for (const grant of result.grants) {
        const old = own.get(grant.ref);
        own.set(grant.ref, {
          ref: grant.ref,
          oid: grant.oid,
          payload: grant.payload,
          touchedAt: grant.payload.blocks.map((_, i) =>
            grant.touched[i] ? now : (old?.touchedAt[grant.prev[i] ?? -1] ?? now),
          ),
          publishedAt: now,
        });
        for (const claim of claims) {
          if (claim.holder.id === grant.holder.id && claim.path === grant.path) settle(claim, { status: "granted" });
        }
      }
      for (const refusal of result.refusals) {
        deps.hooks.emit("sync:lease-refused", {
          workspacePath: root,
          holder: refusal.holder,
          path: absolute(refusal.path),
          holders: refusal.holders,
          reason: refusal.reason,
        });
        for (const claim of claims) {
          if (claim.holder.id === refusal.holder.id && claim.path === refusal.path) {
            settle(claim, { status: "refused", refusal });
          }
        }
      }
    },
    async step(head) {
      if (stopped) return;
      try {
        if (!deps.capabilities().leases) {
          await leaveShared();
          return;
        }
        await publish(dueUpdates());
        // The table and views follow the head and this device's own writes
        // (cached in the worker: only new blobs are read, nothing fetched).
        await read(head);
        announce();
        deliver();
      } catch (error) {
        console.warn("[sync] lease step failed:", error);
      }
    },
    claim(input) {
      const claim: PendingClaim = { ...input, outcome: null };
      claims.push(claim);
      return {
        outcome: () => claim.outcome ?? { status: "unsynced" },
        drop: () => {
          const at = claims.indexOf(claim);
          if (at >= 0) claims.splice(at, 1);
        },
      };
    },
    check(path, blocks) {
      const held = list.filter(
        (lease) => !lease.mine && lease.path === path && lease.blocks.some((b) => blocks.includes(b)),
      );
      if (held.length === 0) return { granted: true };
      return {
        granted: false,
        holders: held.map((lease) => ({ name: lease.holder.name, holderId: lease.holder.id })),
      };
    },
    holdsOf(deviceId) {
      const agents: Record<string, number> = {};
      let total = 0;
      for (const lease of list) {
        if (lease.holder.deviceId !== deviceId) continue;
        total += lease.blocks.length;
        if (lease.holder.taskId) agents[lease.holder.taskId] = (agents[lease.holder.taskId] ?? 0) + lease.blocks.length;
      }
      return { total, agents };
    },
    async goodbye() {
      if (own.size === 0) return;
      const updates = [...own.values()].map((lease) => ({ ref: lease.ref, old: lease.oid, payload: null }));
      own.clear();
      let cancel = () => {};
      await Promise.race([
        deps.api.publishLeases({ updates }).catch(() => undefined),
        new Promise<void>((resolve) => {
          cancel = deps.setTimer(resolve, LEASE_GOODBYE_TIMEOUT_MS);
        }),
      ]);
      cancel();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const port of deps.ports()) {
        if (!port.closed && portKeys.has(port)) port.leases.set([]);
      }
    },
  };
}
