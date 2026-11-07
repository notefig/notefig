/**
 * Leases on the main thread: liveness by local observation (first seen
 * counts as moving then; stale after standing still), what the push asks
 * for, applying grants, idle release and renewal in a request of their
 * own, release when an agent is done and when the level leaves shared, a
 * leftover lease from an earlier run let go, and the editor's views.
 */
import { describe, expect, it, vi } from "vitest";
import { createHooks } from "@notefig/core";
import { createDocumentPort, type SyncLeaseView } from "../document-channel";
import { LEASE_IDLE_MS, LEASE_RENEW_MS, LEASE_STALE_MS, type LeaseHolder } from "../lease-rules";
import { INITIAL_SYNC_STATE, syncCapabilities, transition } from "../sync-machine";
import type { SyncLeasePayload, SyncLeaseRead, SyncRefTip, SyncWorkerApi } from "../sync-types";
import { createLeases } from "./leases";
import { holderSegment } from "./lease-payload";

const DOC = "0".repeat(40);
const C1 = "1".repeat(40);
const ref = (holderId: string) => `refs/notefig/v1/locks/${DOC}/${holderSegment(holderId)}`;
const bo: LeaseHolder = { id: "dev-b", kind: "human", deviceId: "dev-b", name: "Bo", color: "#46a758" };
const me: LeaseHolder = { id: "dev-a", kind: "human", deviceId: "dev-a", name: "Ada", color: "#8e4ec6" };

const payload = (holder: LeaseHolder, blocks: number[], seq = 1): SyncLeasePayload => ({
  v: 1,
  holder,
  path: "a.md",
  commit: C1,
  seq,
  blocks,
});

function setup() {
  let now = 1_000_000;
  let shared = true;
  const state = () => {
    const on = transition(INITIAL_SYNC_STATE, { type: "enable" });
    return syncCapabilities(shared ? transition(on, { type: "peers", present: true }) : on);
  };
  /** What the worker would answer: the payload for each ref it was given. */
  const payloads = new Map<string, SyncLeasePayload>();
  const readLeases = vi.fn<SyncWorkerApi["readLeases"]>(async ({ refs }) => ({
    ok: true,
    value: refs.map(
      (tip): SyncLeaseRead => ({
        ...tip,
        payload: payloads.get(tip.oid) ?? null,
        mapped: payloads.get(tip.oid)?.blocks ?? [],
      }),
    ),
  }));
  let published = 0;
  const publishLeases = vi.fn<SyncWorkerApi["publishLeases"]>(async ({ updates }) => {
    const oids: Record<string, string | null> = {};
    for (const update of updates) {
      if (!update.payload) {
        oids[update.ref] = null;
        continue;
      }
      const oid = `p${++published}`.padEnd(40, "0");
      payloads.set(oid, update.payload);
      oids[update.ref] = oid;
    }
    return { ok: true, value: { status: "published", oids } };
  });
  const hooks = createHooks();
  const moments: string[] = [];
  hooks.on("sync:lease-acquired", ({ holder, blocks }) => void moments.push(`+${holder.id}:${blocks}`));
  hooks.on("sync:lease-released", ({ holder, blocks }) => void moments.push(`-${holder.id}:${blocks}`));
  const port = createDocumentPort("/ws/a.md");
  const leasesChanged = vi.fn();
  const leases = createLeases({
    workspacePath: "/ws",
    deviceId: "dev-a",
    api: { readLeases, publishLeases },
    hooks,
    identity: () => ({ name: "Ada", color: "#8e4ec6" }),
    capabilities: state,
    ports: () => [port],
    leasesChanged,
    now: () => now,
    setTimer: (run, ms) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    },
  });
  leases.start();
  const tip = (holderId: string, p: SyncLeasePayload, oid: string): SyncRefTip => {
    payloads.set(oid, p);
    return { ref: ref(holderId), oid };
  };
  /** Push a grant for this device's person, as the worker would answer. */
  const grant = (blocks: number[], touched: boolean[], prev: Array<number | null>, seq = 1) => {
    const p = payload(me, blocks, seq);
    const oid = `g${seq}`.padEnd(40, "0");
    payloads.set(oid, p);
    leases.pushed({
      grants: [{ holder: me, path: "a.md", ref: ref("dev-a"), oid, payload: p, prev, touched, tookOver: [] }],
      refusals: [],
    });
  };
  return {
    leases,
    hooks,
    port,
    readLeases,
    publishLeases,
    moments,
    leasesChanged,
    tip,
    grant,
    advance: (ms: number) => void (now += ms),
    setShared: (value: boolean) => void (shared = value),
  };
}

describe("lease liveness", () => {
  it("counts a ref as moving when first seen, and stale once this client watched it stand still", async () => {
    const t = setup();
    const tips = [t.tip("dev-b", payload(bo, [2]), "a".repeat(40))];
    await t.leases.observe(tips);
    expect(t.readLeases.mock.calls.at(-1)![0].refs).toEqual([expect.objectContaining({ live: true })]);
    t.advance(LEASE_STALE_MS - 1);
    await t.leases.observe(tips);
    expect(t.readLeases.mock.calls.at(-1)![0].refs[0].live).toBe(true);
    t.advance(1);
    await t.leases.observe(tips);
    expect(t.readLeases.mock.calls.at(-1)![0].refs[0].live).toBe(false);
    // It moves again (a renewal): live again.
    await t.leases.observe([t.tip("dev-b", payload(bo, [2], 2), "b".repeat(40))]);
    expect(t.readLeases.mock.calls.at(-1)![0].refs[0].live).toBe(true);
  });
});

describe("this device's leases", () => {
  it("asks for leases only at the shared level", () => {
    const t = setup();
    expect(t.leases.acquireInput()).toEqual({ human: expect.objectContaining({ id: "dev-a", kind: "human" }), agents: [] });
    t.setShared(false);
    expect(t.leases.acquireInput()).toBeUndefined();
  });

  it("releases blocks idle for LEASE_IDLE_MS, renews held ones, in requests of their own", async () => {
    const t = setup();
    t.grant([1, 2], [true, true], [null, null]);
    await t.leases.step(C1);
    expect(t.publishLeases).not.toHaveBeenCalled();
    expect(t.moments).toEqual(["+dev-a:2"]);
    // Block 2 touched again later (a second push).
    t.advance(LEASE_IDLE_MS / 2);
    t.grant([1, 2], [false, true], [0, 1], 2);
    t.advance(LEASE_IDLE_MS / 2);
    await t.leases.step(C1);
    // Block 1 went idle: released; block 2 kept.
    expect(t.publishLeases).toHaveBeenCalledTimes(1);
    expect(t.publishLeases.mock.calls[0][0].updates).toEqual([
      expect.objectContaining({ ref: ref("dev-a"), payload: expect.objectContaining({ blocks: [2], seq: 3 }) }),
    ]);
    expect(t.moments).toContain("-dev-a:1");
    // Nothing touched: renewed while held…
    t.advance(LEASE_RENEW_MS);
    await t.leases.step(C1);
    expect(t.publishLeases).toHaveBeenCalledTimes(2);
    expect(t.publishLeases.mock.calls[1][0].updates[0].payload?.blocks).toEqual([2]);
    // …until it goes idle: the ref is deleted.
    t.advance(LEASE_IDLE_MS);
    await t.leases.step(C1);
    expect(t.publishLeases.mock.calls.at(-1)![0].updates).toEqual([
      expect.objectContaining({ ref: ref("dev-a"), payload: null }),
    ]);
  });

  it("releases an agent's leases when its turn ends", async () => {
    const t = setup();
    const agent = t.leases.agentHolder("t1", "claude");
    const p = payload(agent, [3]);
    t.leases.pushed({
      grants: [
        { holder: agent, path: "a.md", ref: ref(agent.id), oid: "c".repeat(40), payload: p, prev: [null], touched: [true], tookOver: [] },
      ],
      refusals: [],
    });
    t.hooks.emit("agent:turn-settled", { taskId: "t1" } as never);
    await t.leases.step(C1);
    expect(t.publishLeases.mock.calls[0][0].updates).toEqual([
      expect.objectContaining({ ref: ref("dev-a/t1"), payload: null }),
    ]);
  });

  it("lets go of a lease left over from an earlier run, and of everything when the level leaves shared", async () => {
    const t = setup();
    await t.leases.observe([t.tip("dev-a", payload(me, [1]), "d".repeat(40))]);
    await t.leases.step(C1);
    expect(t.publishLeases.mock.calls[0][0].updates).toEqual([
      expect.objectContaining({ ref: ref("dev-a"), old: "d".repeat(40), payload: null }),
    ]);

    t.grant([2], [true], [null]);
    t.setShared(false);
    await t.leases.step(C1);
    expect(t.publishLeases.mock.calls.at(-1)![0].updates).toEqual([
      expect.objectContaining({ payload: null }),
    ]);
    expect(t.readLeases.mock.calls.at(-1)![0].refs).toEqual([]);
  });
});

describe("the editor's view", () => {
  it("gives each open document its leases, only when they change, and the counts per device", async () => {
    const t = setup();
    const views: SyncLeaseView[][] = [];
    void (async () => {
      for await (const value of t.port.leases) views.push(value);
    })();
    await t.leases.observe([t.tip("dev-b", payload(bo, [2]), "a".repeat(40))]);
    await t.leases.step(C1);
    await t.leases.step(C1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(views).toEqual([[expect.objectContaining({ blockIndex: 2, holderId: "dev-b", mine: false, name: "Bo" })]]);
    expect(t.leasesChanged).toHaveBeenCalledTimes(1);
    expect(t.leases.holdsOf("dev-b")).toEqual({ total: 1, agents: {} });
    expect(t.leases.check("/ws/a.md", [2])).toEqual({ granted: false, holders: [{ name: "Bo", holderId: "dev-b" }] });
    expect(t.leases.check("/ws/a.md", [1])).toEqual({ granted: true });
  });
});
