/**
 * The worker's leases: payloads read defensively, blocks mapped onto the
 * head the same way on every client, the merge's per-block holder, the
 * rule over what a push changes (attributed to the person or the agent),
 * and the rule for an agent's write before it happens.
 */
import { describe, expect, it, vi } from "vitest";
import { ZERO_OID, type GitService } from "@notefig/git";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { splitBlocks } from "../merge/blocks";
import type { LeaseHolder } from "../lease-rules";
import type { SyncLeasePayload } from "../sync-types";
import { createBlockCache } from "./worker-blocks";
import { decodeLease, docIdOf, encodeLease, lockRef } from "./lease-payload";
import {
  createLeaseTable,
  holderFor,
  planAcquisitions,
  planWrite,
  prepareLeaseBlocks,
  readLeases,
  type LeaseContext,
} from "./sync-worker-leases";

const codec = createMarkdownCodec();
const split = (markdown: string) => splitBlocks(codec, markdown);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const BASE = ["# Title", "Alpha.", "Beta.", "Gamma."].join("\n\n") + "\n";

const ada: LeaseHolder = { id: "dev-a", kind: "human", deviceId: "dev-a", name: "Ada", color: "#8e4ec6" };
const bo: LeaseHolder = { id: "dev-b", kind: "human", deviceId: "dev-b", name: "Bo", color: "#46a758" };
const boAgent: LeaseHolder = {
  id: "dev-b/t1",
  kind: "agent",
  deviceId: "dev-b",
  name: "Bo",
  color: "#46a758",
  taskId: "t1",
  harness: "claude",
};

const lease = (holder: LeaseHolder, blocks: number[], commit = C1): SyncLeasePayload => ({
  v: 1,
  holder,
  path: "a.md",
  commit,
  seq: 1,
  blocks,
});

/** A worker context over in-memory commits and blobs. */
function context(files: Record<string, string>, head = C2) {
  const blobs = new Map<string, Uint8Array>();
  let next = 0;
  const pushed: Array<{ ref: string; old: string; new: string }[]> = [];
  const service = {
    readTextFile: vi.fn(async ({ ref, filepath }: { ref: string; filepath: string }) => {
      const text = files[`${ref}:${filepath}`];
      if (text === undefined) throw new Error("missing");
      return text;
    }),
    readBlob: vi.fn(async (oid: string) => {
      const blob = blobs.get(oid);
      if (!blob) throw new Error("missing");
      return blob;
    }),
    writeBlob: vi.fn(async (bytes: Uint8Array) => {
      const oid = (++next).toString(16).padStart(40, "b");
      blobs.set(oid, bytes);
      return oid;
    }),
    fetchRefs: vi.fn(async () => ({ refs: [], missing: [], objectCount: 0 })),
    changedFiles: vi.fn(async () => [{ path: "a.md", from: "f".repeat(40), to: "e".repeat(40) }]),
    pushRefs: vi.fn(async (_remote: unknown, updates: { ref: string; old: string; new: string }[]) => {
      pushed.push(updates);
      return { ok: true, unpack: "ok", refs: [], messages: [] };
    }),
  } as unknown as GitService;
  const ctx: LeaseContext = {
    service,
    remote: { url: "https://example.test/o/r.git" },
    head: async () => head,
    loadBlocks: async () => split,
    cache: createBlockCache(),
    table: createLeaseTable(),
  };
  /** Put a lease blob in, as a fetched ref would be. */
  const put = async (payload: SyncLeasePayload) => {
    const oid = await service.writeBlob(encodeLease(payload));
    return { ref: lockRef(await docIdOf(payload.path), payload.holder.id), oid };
  };
  return { ctx, service, put, pushed };
}

describe("lease payloads", () => {
  it("round-trip, and are refused when the ref doesn't match the document or the holder", async () => {
    const payload = lease(boAgent, [1, 2]);
    const ref = lockRef(await docIdOf("a.md"), boAgent.id);
    expect(ref).toMatch(/\/locks\/[0-9a-f]{40}\/dev-b\.2ft1$/);
    expect(await decodeLease(encodeLease(payload), ref)).toEqual(payload);
    // A forged path (another document's ref) or holder is dropped.
    expect(await decodeLease(encodeLease({ ...payload, path: "b.md" }), ref)).toBeNull();
    expect(await decodeLease(encodeLease({ ...payload, holder: { ...bo } }), ref)).toBeNull();
    expect(await decodeLease(new TextEncoder().encode("{nope"), ref)).toBeNull();
  });
});

describe("reading leases", () => {
  it("maps blocks onto the head with the merge's alignment, the same on every client", async () => {
    const after = BASE.replace("Alpha.", "Inserted.\n\nAlpha.");
    const files = { [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: after };
    const one = context(files);
    const two = context(files);
    const tipOne = await one.put(lease(ada, [2, 3]));
    const tipTwo = await two.put(lease(ada, [2, 3]));
    const readOne = await readLeases(one.ctx, { refs: [{ ...tipOne, live: true }], self: "dev-b" });
    const readTwo = await readLeases(two.ctx, { refs: [{ ...tipTwo, live: true }], self: "dev-c" });
    // Beta. and Gamma. moved down one.
    expect(readOne[0].mapped).toEqual([3, 4]);
    expect(readTwo[0].mapped).toEqual(readOne[0].mapped);
    expect(one.ctx.table.entries).toHaveLength(1);
    // An empty read clears the table (solo).
    await readLeases(one.ctx, { refs: [], self: "dev-b" });
    expect(one.ctx.table.entries).toEqual([]);
  });
});

describe("the merge's holder", () => {
  it("gives an overlap to the side whose holder leases it", async () => {
    const { ctx, put } = context({ [`${C1}:a.md`]: BASE });
    const mine = await put(lease(ada, [1]));
    const theirs = await put(lease(bo, [3]));
    await readLeases(ctx, {
      refs: [
        { ...mine, live: true },
        { ...theirs, live: true },
      ],
      self: "dev-a",
    });
    await prepareLeaseBlocks(ctx);
    const holder = holderFor(ctx, "a.md")!;
    const base = split(BASE);
    expect(holder({ start: 1, end: 2, base })).toBe("ours");
    expect(holder({ start: 3, end: 4, base })).toBe("theirs");
    // Nobody leases block 2: the default (the branch's side).
    expect(holder({ start: 2, end: 3, base })).toBe("theirs");
    // An insert right after a leased block is the holder's too.
    expect(holder({ start: 2, end: 2, base })).toBe("ours");
    expect(holderFor(ctx, "other.md")).toBeNull();
  });

  it("ignores stale leases", async () => {
    const { ctx, put } = context({ [`${C1}:a.md`]: BASE });
    const tip = await put(lease(ada, [1]));
    await readLeases(ctx, { refs: [{ ...tip, live: false }], self: "dev-a" });
    expect(holderFor(ctx, "a.md")).toBeNull();
  });
});

describe("what a push acquires", () => {
  it("attributes each changed stretch to its writer and takes their leases, all or nothing per holder", async () => {
    const remote = BASE;
    const head = BASE.replace("Alpha.", "Alpha, by Bo.").replace("Gamma.", "Gamma, by the agent.");
    const { ctx, service } = context({ [`${C1}:a.md`]: remote, [`${C2}:a.md`]: head });
    await readLeases(ctx, { refs: [], self: "dev-b" });
    const plan = await planAcquisitions(ctx, {
      remote: C1,
      head: C2,
      acquire: {
        human: bo,
        agents: [{ holder: boAgent, path: "a.md", content: BASE.replace("Gamma.", "Gamma, by the agent.") }],
      },
    });
    expect(plan.result.refusals).toEqual([]);
    const byHolder = Object.fromEntries(plan.result.grants.map((grant) => [grant.holder.id, grant.payload.blocks]));
    expect(byHolder).toEqual({ "dev-b": [1], "dev-b/t1": [3] });
    expect(plan.updates.every((update) => update.old === ZERO_OID)).toBe(true);
    expect(plan.result.grants[0].payload.commit).toBe(C2);
    expect(service.writeBlob).toHaveBeenCalledTimes(2);
  });

  it("refuses a holder whose change touches a live lease, and takes over a stale one with a CAS delete", async () => {
    const head = BASE.replace("Beta.", "Beta, by Bo.");
    const { ctx, put } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: head });
    const adaTip = await put(lease(ada, [2]));
    await readLeases(ctx, { refs: [{ ...adaTip, live: true }], self: "dev-b" });
    const refused = await planAcquisitions(ctx, { remote: C1, head: C2, acquire: { human: bo, agents: [] } });
    expect(refused.updates).toEqual([]);
    expect(refused.result.refusals).toEqual([
      expect.objectContaining({ holder: bo, holders: [ada], reason: "held", blocks: [2] }),
    ]);

    await readLeases(ctx, { refs: [{ ...adaTip, live: false }], self: "dev-b" });
    const taken = await planAcquisitions(ctx, { remote: C1, head: C2, acquire: { human: bo, agents: [] } });
    expect(taken.result.grants[0].tookOver).toEqual([ada]);
    expect(taken.updates).toContainEqual({ ref: adaTip.ref, old: adaTip.oid, new: ZERO_OID });
  });

  it("extends a holder's own lease, keeping where each block came from", async () => {
    const head = BASE.replace("Gamma.", "Gamma, again.");
    const { ctx, put } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: head });
    const own = await put(lease(bo, [1]));
    await readLeases(ctx, { refs: [{ ...own, live: true }], self: "dev-b" });
    const plan = await planAcquisitions(ctx, { remote: C1, head: C2, acquire: { human: bo, agents: [] } });
    const grant = plan.result.grants[0];
    expect(grant.payload.blocks).toEqual([1, 3]);
    expect(grant.prev).toEqual([0, null]);
    expect(grant.touched).toEqual([false, true]);
    expect(grant.payload.seq).toBe(2);
    expect(plan.updates[0]).toEqual(expect.objectContaining({ ref: own.ref, old: own.oid }));
  });
});

describe("an agent's write, before it happens", () => {
  it("a whole-file rewrite needs every block; a targeted edit only its own", async () => {
    const { ctx, put } = context({ [`${C2}:a.md`]: BASE }, C2);
    const tip = await put(lease(ada, [1], C2));
    await readLeases(ctx, { refs: [{ ...tip, live: true }], self: "dev-b" });
    const rewrite = split(BASE).map((block) => `${block} (new)`).join("\n\n");
    expect(await planWrite(ctx, { path: "a.md", current: BASE, content: rewrite, holder: boAgent })).toEqual({
      granted: false,
      reason: "held",
      holders: [ada],
      blocks: [1],
    });
    const targeted = BASE.replace("Gamma.", "Gamma, edited.");
    expect(await planWrite(ctx, { path: "a.md", current: BASE, content: targeted, holder: boAgent })).toEqual({
      granted: true,
      needed: [3],
    });
    // An insert right below Ada's block needs it: refused.
    const below = BASE.replace("Alpha.", "Alpha.\n\nNew.");
    expect(await planWrite(ctx, { path: "a.md", current: BASE, content: below, holder: boAgent })).toMatchObject({
      granted: false,
    });
  });

  it("maps the leases onto the text the writer sees (an editor's unsaved blocks)", async () => {
    const { ctx, put } = context({ [`${C2}:a.md`]: BASE }, C2);
    const tip = await put(lease(ada, [3], C2));
    await readLeases(ctx, { refs: [{ ...tip, live: true }], self: "dev-b" });
    // The editor has a block inserted at the top that isn't committed yet:
    // Gamma. is block 4 there.
    const current = BASE.replace("# Title", "# Title\n\nUnsaved.");
    const content = current.replace("Gamma.", "Gamma, edited.");
    expect(await planWrite(ctx, { path: "a.md", current, content, holder: boAgent })).toMatchObject({
      granted: false,
      blocks: [4],
    });
  });
});

