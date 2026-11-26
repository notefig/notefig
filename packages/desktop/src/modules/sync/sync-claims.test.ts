import { describe, expect, it } from "vitest";
import { CLAIM_IDLE_MS, MAX_CLAIMS, branchKeys, createClaims } from "./sync-claims";
import type { SyncClaim, SyncPeer } from "./sync-machine";

const peer = (deviceId: string, claims: SyncClaim[] = []): SyncPeer => ({
  deviceId,
  name: deviceId === "a" ? "Ada" : "Bob",
  colour: "#2f7ed8",
  wip: null,
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

/** Toy keys: each names itself. */
const same = { resolve: (key: string) => key };
const edit = (before: (string | null)[], after: (string | null)[]) => ({ before, after });

describe("sync claims", () => {
  it("claims the units an edit touches, by what they said before and what they say now", () => {
    const { claims } = claimsWith();
    expect(claims.take("a.md", edit(["k1"], ["k2"]), false, same)).toBeNull();
    expect(claims.take("a.md", edit(["k2"], ["k3"]), false, same)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k3"], agent: false }]);
  });

  it("refuses an edit to a unit another device holds, naming it, and claims nothing", () => {
    const bob = peer("z", [{ path: "a.md", keys: ["k1"], agent: true }]);
    const { claims } = claimsWith([bob]);
    expect(claims.take("a.md", edit(["k0", "k1"], ["k9"]), false, same)).toEqual({
      kind: "held",
      holders: [{ peer: bob, agent: true }],
    });
    expect(claims.published()).toEqual([]);
    // Another file, or another unit of it, is free.
    expect(claims.take("b.md", edit(["k1"], ["k2"]), false, same)).toBeNull();
    expect(claims.heldIn("a.md", same).get("k1")).toEqual({ peer: bob, agent: true });
  });

  it(`holds at most ${MAX_CLAIMS} units, its user's and its agents' together`, () => {
    const { claims } = claimsWith();
    for (const key of ["k1", "k2"]) expect(claims.take("a.md", edit([key], [`${key}'`]), false, same)).toBeNull();
    for (const key of ["k3", "k4"]) expect(claims.take("a.md", edit([key], [`${key}'`]), true, same)).toBeNull();
    expect(claims.take("a.md", edit(["k5"], ["k5'"]), false, same)).toEqual({ kind: "cap", needed: 5 });
    expect(claims.take("a.md", edit(["k5"], ["k5'"]), true, same)).toEqual({ kind: "cap", needed: 5 });
    // What it already holds stays editable, and a new unit is never refused.
    expect(claims.take("a.md", edit(["k1'"], ["k1''"]), true, same)).toBeNull();
    expect(claims.take("a.md", edit([null], ["new"]), false, same)).toBeNull();
    expect(claims.published()).toHaveLength(MAX_CLAIMS);
  });

  it("lets its agents edit what its user is editing: one holder", () => {
    const { claims } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false, same);
    expect(claims.take("a.md", edit(["k2"], ["k3"]), true, same)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k3"], agent: true }]);
  });

  it("makes a new unit yours at once, and a joined one names both", () => {
    const { claims } = claimsWith();
    claims.take("a.md", edit([null], ["typed"]), false, same);
    claims.take("a.md", edit(["k1", "k2"], ["k12"]), false, same);
    expect(claims.published()).toEqual([
      { path: "a.md", keys: ["typed"], agent: false },
      { path: "a.md", keys: ["k1", "k2", "k12"], agent: false },
    ]);
  });

  it("names every unit a join changed, so none of them goes unclaimed elsewhere", () => {
    const { claims } = claimsWith();
    expect(claims.take("a.md", edit(["k1", "k2", "k3"], ["k123"]), false, same)).toBeNull();
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k1", "k2", "k3", "k123"], agent: false }]);
    // One claim can't name more than MAX_CLAIM_KEYS units: refused, not dropped.
    const many = Array.from({ length: 13 }, (_, i) => `j${i}`);
    expect(claims.take("b.md", edit(many, ["joined"]), true, same)).toMatchObject({ kind: "cap" });
  });

  it("of two devices claiming one unit, the lower id holds it; the other lets go", () => {
    const { claims, list } = claimsWith();
    claims.take("a.md", edit(["k1"], ["mine"]), false, same);
    claims.take("a.md", edit(["k2"], ["mine2"]), false, same);
    list.peers = [peer("a", [{ path: "a.md", keys: ["k1", "ada"], agent: false }]), peer("z", [{ path: "a.md", keys: ["k2", "zed"], agent: false }])];
    // Ada (lower) holds k1 over this device, its own text of it too; this
    // device holds k2 over z.
    expect([...claims.heldIn("a.md", same).keys()]).toEqual(["k1", "ada", "mine"]);
    expect(claims.expire()).toBe(true);
    expect(claims.published()).toEqual([{ path: "a.md", keys: ["k2", "mine2"], agent: false }]);
    // Its own text of the unit it lost stays Ada's until she lets go.
    expect(claims.heldIn("a.md", same).get("mine")?.peer.deviceId).toBe("a");
    expect(claims.take("a.md", edit(["mine"], ["again"]), false, same)).toMatchObject({ kind: "held" });
    list.peers = [peer("a"), peer("z")];
    expect(claims.expire()).toBe(true);
    expect(claims.heldIn("a.md", same).size).toBe(0);
  });

  it("says which files it won a unit in, so its text stands where the edits collide", () => {
    const { claims, list } = claimsWith();
    claims.take("a.md", edit(["k1"], ["mine"]), false, same);
    claims.take("b.md", edit(["k2"], ["mine2"]), false, same);
    list.peers = [peer("z", [{ path: "a.md", keys: ["k1", "zed"], agent: false }]), peer("a", [{ path: "b.md", keys: ["k2", "ada"], agent: false }])];
    expect(claims.won("a.md")).toBe(true);
    // Ada's id is lower: she won b.md's unit.
    expect(claims.won("b.md")).toBe(false);
    // Nobody else claimed what it holds in c.md, or it holds nothing there.
    expect(claims.won("c.md")).toBe(false);
    // z's claim ends before its text comes in: a.md's unit is still won.
    list.peers = [];
    expect(claims.won("a.md")).toBe(true);
  });

  it("sees a race on a unit whose neighbour one side changed first, and keeps the caret's claim when the text above moves", () => {
    const { claims, list } = claimsWith();
    // Its key before its edit, here and at Ada's: the unit above differs.
    claims.take("a.md", edit(["t1.up.down.0"], ["t2.up.down.0"]), false, same);
    claims.setCaret({ path: "a.md", key: "t2.changed.down.0" });
    expect(claims.expire()).toBe(false);
    list.peers = [peer("a", [{ path: "a.md", keys: ["t1.ada.down.0", "t3.ada.down.0"], agent: false }])];
    expect(claims.expire()).toBe(true);
    expect(claims.published()).toEqual([]);
  });

  it(`stops typing ${CLAIM_IDLE_MS / 1000} s after its last edit, caret or not, and holds the unit until the edit is on the branch`, () => {
    const { claims, tick, now } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false, same);
    claims.setCaret({ path: "a.md", key: "k2" });
    tick(CLAIM_IDLE_MS - 1);
    expect(claims.typing()).toBe(true);
    tick(1);
    expect(claims.typing()).toBe(false);
    // Idle, but the branch still has the old text: nobody else may edit it yet.
    expect(claims.expire()).toBe(false);
    claims.landed(now(), () => false);
    expect(claims.expire()).toBe(true);
    expect(claims.published()).toEqual([]);
  });

  it("ends a claim the caret left once its edit is on the branch, and names it by what landed", () => {
    const { claims, tick, now } = claimsWith();
    claims.take("a.md", edit(["k1"], ["k2"]), false, same);
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
    claims.take("a.md", edit(["k1"], ["k2"]), true, same);
    tick(500);
    claims.landed(now(), () => false);
    expect(claims.expire()).toBe(false);
    tick(2_000);
    claims.landed(now(), () => false);
    // An agent has no caret: done once it's on the branch.
    expect(claims.expire()).toBe(true);
  });
});

describe("branchKeys", () => {
  const unit = (key: string, content = key) => ({ key, content });
  it("pairs each unit here with the one it was on the branch: alike, or changed in order", () => {
    const keys = branchKeys(
      [unit("title"), unit("typed", "Typed."), unit("fresh", "Fresh.")],
      [unit("title"), unit("more", "More typed."), unit("again", "Fresh. Again."), unit("new", "New.")],
    );
    expect(Object.fromEntries(keys)).toEqual({ title: "title", more: "typed", again: "fresh" });
  });
});
