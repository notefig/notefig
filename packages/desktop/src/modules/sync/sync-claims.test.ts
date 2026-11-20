import { describe, expect, it } from "vitest";
import { CLAIM_IDLE_MS, MAX_CLAIMS, createClaims } from "./sync-claims";
import type { SyncClaim, SyncPeer } from "./sync-machine";

const peer = (deviceId: string, claims: SyncClaim[] = []): SyncPeer => ({
  deviceId,
  name: deviceId === "a" ? "Ada" : "Bob",
  colour: "#2f7ed8",
  cursor: null,
  claims,
});

/** This device is `m`: it holds a race against `z`, loses one to `a`. */
function claimsWith(peers: SyncPeer[] = []) {
  let at = 1_000_000;
  const list = { peers };
  const claims = createClaims({ deviceId: "m", now: () => at, peers: () => list.peers });
  return {
    claims,
    list,
    tick: (ms: number) => (at += ms),
    now: () => at,
  };
}

const edit = (before: (string | null)[], after: (string | null)[]) => ({ before, after });

describe("sync claims", () => {
  it("claims the units an edit touches, by what they said before and what they say now", () => {
    const { claims } = claimsWith();
    expect(claims.take("a.md", edit(["k1"], ["k2"]), false)).toBeNull();
    expect(claims.take("a.md", edit(["k2"], ["k3"]), false)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k3"], agent: false }]);
  });

  it("refuses an edit to a unit another device holds, naming it, and claims nothing", () => {
    const bob = peer("z", [{ path: "a.md", keys: ["k1"], agent: true }]);
    const { claims } = claimsWith([bob]);
    expect(claims.take("a.md", edit(["k0", "k1"], ["k9"]), false)).toEqual({
      kind: "held",
      holders: [{ peer: bob, agent: true }],
    });
    expect(claims.published()).toEqual([]);
    // Another file, or another unit of it, is free.
    expect(claims.take("b.md", edit(["k1"], ["k2"]), false)).toBeNull();
    expect(claims.heldIn("a.md").get("k1")).toEqual({ peer: bob, agent: true });
  });

  it(`holds at most ${MAX_CLAIMS} units, its user's and its agents' together`, () => {
    const { claims } = claimsWith();
    for (const key of ["k1", "k2"]) expect(claims.take("a.md", edit([key], [`${key}'`]), false)).toBeNull();
    for (const key of ["k3", "k4"]) expect(claims.take("a.md", edit([key], [`${key}'`]), true)).toBeNull();
    expect(claims.take("a.md", edit(["k5"], ["k5'"]), false)).toEqual({ kind: "cap", needed: 5 });
    expect(claims.take("a.md", edit(["k5"], ["k5'"]), true)).toEqual({ kind: "cap", needed: 5 });
    // What it already holds stays editable, and a new unit is never refused.
    expect(claims.take("a.md", edit(["k1'"], ["k1''"]), true)).toBeNull();
    expect(claims.take("a.md", edit([null], ["new"]), false)).toBeNull();
    expect(claims.published()).toHaveLength(MAX_CLAIMS);
  });

  it("lets its agents edit what its user is editing: one holder", () => {
    const { claims } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false);
    expect(claims.take("a.md", edit(["k2"], ["k3"]), true)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k3"], agent: true }]);
  });

  it("makes a new unit yours at once, and a joined one names both", () => {
    const { claims } = claimsWith();
    claims.take("a.md", edit([null], ["typed"]), false);
    claims.take("a.md", edit(["k1", "k2"], ["k12"]), false);
    expect(claims.published()).toEqual([
      { path: "a.md", keys: ["typed"], agent: false },
      { path: "a.md", keys: ["k1", "k2", "k12"], agent: false },
    ]);
  });

  it("names every unit a join changed, so none of them goes unclaimed elsewhere", () => {
    const { claims } = claimsWith();
    expect(claims.take("a.md", edit(["k1", "k2", "k3"], ["k123"]), false)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k2", "k3", "k123"], agent: false }]);
    // One claim can't name more than MAX_CLAIM_KEYS units: refused, not dropped.
    const many = Array.from({ length: 13 }, (_, i) => `j${i}`);
    expect(claims.take("b.md", edit(many, ["joined"]), true)).toMatchObject({ kind: "cap" });
  });

  it("of two devices claiming one unit, the lower id holds it; the other lets go", () => {
    const { claims, list } = claimsWith();
    claims.take("a.md", edit(["k1"], ["mine"]), false);
    claims.take("a.md", edit(["k2"], ["mine2"]), false);
    list.peers = [peer("a", [{ path: "a.md", keys: ["k1", "ada"], agent: false }]), peer("z", [{ path: "a.md", keys: ["k2", "zed"], agent: false }])];
    // Ada (lower) holds k1 over this device, its own text of it too; this
    // device holds k2 over z.
    expect([...claims.heldIn("a.md").keys()]).toEqual(["k1", "ada", "mine"]);
    expect(claims.expire()).toBe(true);
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k2", "mine2"], agent: false }]);
    // Its own text of the unit it lost stays Ada's until she lets go.
    expect(claims.heldIn("a.md").get("mine")?.peer.deviceId).toBe("a");
    expect(claims.take("a.md", edit(["mine"], ["again"]), false)).toMatchObject({ kind: "held" });
    list.peers = [peer("a"), peer("z")];
    expect(claims.expire()).toBe(true);
    expect(claims.heldIn("a.md").size).toBe(0);
  });

  it(`ends a claim ${CLAIM_IDLE_MS / 1000} s after its last edit, wherever the caret is`, () => {
    const { claims, tick } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false);
    claims.setCaret({ path: "a.md", key: "k2" });
    tick(CLAIM_IDLE_MS - 1);
    expect(claims.expire()).toBe(false);
    tick(1);
    expect(claims.expire()).toBe(true);
    expect(claims.published()).toEqual([]);
  });

  it("ends a claim the caret left once its edit is on the branch, and names it by what landed", () => {
    const { claims, tick, now } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false);
    claims.setCaret({ path: "a.md", key: "k2" });
    tick(3_000);
    const asked: string[] = [];
    claims.landed(now(), (path) => (asked.push(path), false));
    // Still here: not asked (asking saves), and still held, by what landed too.
    expect(asked).toEqual([]);
    expect(claims.expire()).toBe(false);
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k2"], agent: false }]);
    claims.setCaret({ path: "a.md", key: "elsewhere" });
    // Unsaved yet: kept.
    claims.landed(now(), () => true);
    expect(claims.expire()).toBe(false);
    claims.landed(now(), () => false);
    expect(claims.expire()).toBe(true);
  });

  it("keeps a claim whose edit may still be in the autosave", () => {
    const { claims, tick, now } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), true);
    tick(500);
    claims.landed(now(), () => false);
    expect(claims.expire()).toBe(false);
    tick(2_000);
    claims.landed(now(), () => false);
    // An agent has no caret: done once it's on the branch.
    expect(claims.expire()).toBe(true);
  });
});
