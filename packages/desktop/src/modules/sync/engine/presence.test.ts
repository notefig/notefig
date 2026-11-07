/**
 * Presence's main-thread logic over a fake worker: liveness by local
 * observation (decision 7), the solo ↔ shared input, when this device
 * publishes, what it publishes, and goodbye.
 */
import { describe, expect, it, vi } from "vitest";
import { createHooks } from "@notefig/core";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { createDocumentPort, type SyncDocumentPort } from "../document-channel";
import { INITIAL_SYNC_STATE, syncCapabilities, transition } from "../sync-machine";
import type {
  SyncPeer,
  SyncPresenceDraft,
  SyncPresencePayload,
  SyncPresencePublishOutcome,
  SyncPresenceRead,
  SyncRefTip,
  SyncResult,
  SyncWorkerApi,
} from "../sync-types";
import { createPresenceLiveness, PRESENCE_STALE_MS } from "./presence-liveness";
import {
  createPresence,
  presenceDue,
  PRESENCE_HEARTBEAT_FOCUSED_MS,
  PRESENCE_HEARTBEAT_IDLE_MS,
  PRESENCE_MIN_INTERVAL_SHARED_MS,
  PRESENCE_MIN_INTERVAL_SOLO_MS,
} from "./presence";
import { decodePresence, encodePresence, presenceRef } from "./presence-payload";

const WS = "/ws";
const HEAD = "a".repeat(40);

describe("liveness", () => {
  it("counts a device live while its ref moves, by the local clock only", () => {
    let now = 1_000;
    const liveness = createPresenceLiveness({ now: () => now });
    liveness.observe(new Map());
    liveness.observe(new Map([["b", "oid-1"]]));
    expect(liveness.live()).toEqual(["b"]);
    now += PRESENCE_STALE_MS - 1;
    // Unmoved: still live until the window ends…
    liveness.observe(new Map([["b", "oid-1"]]));
    expect(liveness.live()).toEqual(["b"]);
    now += 1;
    expect(liveness.live()).toEqual([]);
    // …and a move brings it back.
    liveness.observe(new Map([["b", "oid-2"]]));
    expect(liveness.live()).toEqual(["b"]);
    expect(liveness.changedAt("b")).toBe(now);
  });

  it("leaves refs already there on the first poll dormant until they move", () => {
    let now = 0;
    const liveness = createPresenceLiveness({ now: () => now });
    liveness.observe(new Map([["crashed", "oid-1"]]));
    expect(liveness.live()).toEqual([]);
    now += 5_000;
    liveness.observe(new Map([["crashed", "oid-2"]]));
    expect(liveness.live()).toEqual(["crashed"]);
  });

  it("drops a device whose ref was deleted at once", () => {
    const liveness = createPresenceLiveness({ now: () => 0 });
    liveness.observe(new Map());
    liveness.observe(new Map([["b", "oid-1"]]));
    liveness.observe(new Map());
    expect(liveness.live()).toEqual([]);
  });
});

describe("when presence is due", () => {
  const base = { now: 100_000, changed: false, shared: false, focused: true };
  it("publishes at once the first time", () => {
    expect(presenceDue({ ...base, lastAt: null })).toBe(true);
  });
  it("publishes a change at most every interval of its level", () => {
    const at = (since: number, shared: boolean) =>
      presenceDue({ ...base, shared, changed: true, lastAt: base.now - since });
    expect(at(PRESENCE_MIN_INTERVAL_SHARED_MS - 1, true)).toBe(false);
    expect(at(PRESENCE_MIN_INTERVAL_SHARED_MS, true)).toBe(true);
    expect(at(PRESENCE_MIN_INTERVAL_SOLO_MS - 1, false)).toBe(false);
    expect(at(PRESENCE_MIN_INTERVAL_SOLO_MS, false)).toBe(true);
  });
  it("heartbeats fast while shared and focused, slowly otherwise", () => {
    const at = (since: number, shared: boolean, focused: boolean) =>
      presenceDue({ ...base, shared, focused, lastAt: base.now - since });
    expect(at(PRESENCE_HEARTBEAT_FOCUSED_MS - 1, true, true)).toBe(false);
    expect(at(PRESENCE_HEARTBEAT_FOCUSED_MS, true, true)).toBe(true);
    expect(at(PRESENCE_HEARTBEAT_FOCUSED_MS, true, false)).toBe(false);
    expect(at(PRESENCE_HEARTBEAT_FOCUSED_MS, false, true)).toBe(false);
    expect(at(PRESENCE_HEARTBEAT_IDLE_MS, false, true)).toBe(true);
    expect(PRESENCE_HEARTBEAT_IDLE_MS).toBeLessThan(PRESENCE_STALE_MS - 15_000);
  });
});

function payloadOf(deviceId: string, extra: Partial<SyncPresencePayload> = {}): SyncPresencePayload {
  return {
    v: 1,
    user: { name: `User ${deviceId}`, color: "#0090ff" },
    deviceId,
    commit: HEAD,
    seq: 1,
    focused: true,
    cursors: [],
    agents: [],
    ...extra,
  };
}

/** A presence over a fake worker; `remote` is what the polls see. */
function setup(options: { tasks?: AgentTaskRow[] } = {}) {
  let now = 0;
  let state = transition(INITIAL_SYNC_STATE, { type: "enable" });
  const payloads = new Map<string, SyncPresencePayload>();
  const published: SyncPresenceDraft[] = [];
  const deleted: { ref: string; old: string }[] = [];
  const remote = new Map<string, string>();
  let oids = 0;
  const api: Pick<SyncWorkerApi, "publishPresence" | "deletePresence" | "readPresence"> = {
    publishPresence: vi.fn(async ({ ref, old, draft }): Promise<SyncResult<SyncPresencePublishOutcome>> => {
      if ((remote.get(ref) ?? null) !== old) return { ok: true, value: { status: "rejected" } };
      published.push(draft);
      const oid = `own-${(oids += 1)}`;
      remote.set(ref, oid);
      return { ok: true, value: { status: "published", oid } };
    }),
    deletePresence: vi.fn(async (input): Promise<SyncResult<{ deleted: boolean }>> => {
      deleted.push(input);
      remote.delete(input.ref);
      return { ok: true, value: { deleted: true } };
    }),
    readPresence: vi.fn(async ({ refs }: { refs: SyncRefTip[] }) => ({
      ok: true as const,
      value: refs.map(
        (tip): SyncPresenceRead => ({ ...tip, payload: payloads.get(tip.oid) ?? null }),
      ),
    })),
  };
  const peersSeen: (readonly SyncPeer[])[] = [];
  const ports: SyncDocumentPort[] = [];
  const hooks = createHooks();
  const presence = createPresence({
    workspacePath: WS,
    deviceId: "me",
    api,
    hooks,
    identity: () => ({ name: "Me", color: "#e5484d" }),
    capabilities: () => syncCapabilities(state),
    setPeersPresent: (present) => {
      state = transition(state, { type: "peers", present });
    },
    presenceChanged: (peers) => void peersSeen.push(peers),
    ports: () => ports,
    agentTasks: () => options.tasks ?? [],
    isFocused: () => true,
    now: () => now,
    setTimer: (run, ms) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    },
  });
  presence.start();
  /** Another device publishes `payload` (a new blob each time). */
  const peerPublishes = (deviceId: string, payload = payloadOf(deviceId)) => {
    const oid = `${deviceId}-${(oids += 1)}`;
    payloads.set(oid, payload);
    remote.set(presenceRef(deviceId), oid);
  };
  const poll = () => presence.step([...remote].map(([ref, oid]) => ({ ref, oid })), HEAD);
  return {
    presence,
    api,
    hooks,
    remote,
    published,
    deleted,
    peersSeen,
    ports,
    peerPublishes,
    poll,
    level: () => state.level,
    advance: (ms: number) => void (now += ms),
  };
}

describe("presence", () => {
  it("goes shared on another device's live presence and back to solo when it stops moving", async () => {
    const t = setup();
    await t.poll();
    expect(t.level()).toBe("solo");
    t.peerPublishes("b");
    await t.poll();
    expect(t.level()).toBe("shared");
    expect(t.presence.peers().map((peer) => peer.name)).toEqual(["User b"]);
    // Polls go on; b's ref never moves again.
    t.advance(PRESENCE_STALE_MS);
    await t.poll();
    expect(t.level()).toBe("solo");
    expect(t.presence.peers()).toEqual([]);
  });

  it("ignores timestamps in a payload: an unmoved ref ages out whatever it claims", async () => {
    const t = setup();
    await t.poll();
    const forged = {
      ...payloadOf("b"),
      // A far-future "last seen" and focus time, as a skewed or forged
      // client might send: not part of the format, and never read.
      at: Date.now() + 10 ** 9,
      focusedAt: Date.now() + 10 ** 9,
    } as SyncPresencePayload;
    t.peerPublishes("b", forged);
    await t.poll();
    expect(t.level()).toBe("shared");
    t.advance(PRESENCE_STALE_MS);
    await t.poll();
    expect(t.level()).toBe("solo");
    // And the decoder drops what isn't the format.
    const decoded = decodePresence(encodePresence(forged))!;
    expect(decoded).not.toHaveProperty("at");
    expect(decoded).not.toHaveProperty("focusedAt");
  });

  it("goes back to solo at once when the other device says goodbye", async () => {
    const t = setup();
    await t.poll();
    t.peerPublishes("b");
    await t.poll();
    expect(t.level()).toBe("shared");
    t.remote.delete(presenceRef("b"));
    await t.poll();
    expect(t.level()).toBe("solo");
  });

  it("publishes once, then only on a heartbeat or a change, and greets a new peer at once", async () => {
    const t = setup();
    await t.poll();
    expect(t.published).toHaveLength(1);
    t.advance(1_000);
    await t.poll();
    expect(t.published).toHaveLength(1);
    t.advance(PRESENCE_HEARTBEAT_IDLE_MS);
    await t.poll();
    expect(t.published).toHaveLength(2);
    expect(t.published[1].seq).toBeGreaterThan(t.published[0].seq);
    // A new peer: republish now, so it sees this device move.
    t.peerPublishes("b");
    t.advance(10);
    await t.poll();
    expect(t.published).toHaveLength(3);
  });

  it("publishes the attached editors' carets and this device's running agents", async () => {
    const t = setup({
      tasks: [
        {
          taskId: "task-1",
          workspacePath: WS,
          title: "Tighten the intro",
          status: "running",
          harnessId: "claude",
          createdAt: 0,
          updatedAt: 0,
        },
        {
          taskId: "task-2",
          workspacePath: WS,
          title: "Idle one",
          status: "idle",
          harnessId: "codex",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const port = createDocumentPort("/ws/notes/a.md");
    t.ports.push(port);
    port.channel.setCursor({
      anchor: { blockIndex: 2, offset: 3 },
      head: { blockIndex: 2, offset: 7 },
    });
    t.hooks.emit("agent:tool-call", {
      taskId: "task-1",
      turnId: "turn-1",
      workspacePath: WS,
      toolCall: {
        toolCallId: "call-1",
        status: "in_progress",
        kind: "edit",
        locations: [{ path: "notes/a.md" }],
        content: [{ type: "diff", path: "/ws/notes/a.md", oldText: "Old", newText: "New text" }],
      },
    });
    await t.poll();
    const [draft] = t.published;
    expect(draft.user).toEqual({ name: "Me", color: "#e5484d" });
    expect(draft.cursors).toEqual([
      { path: "notes/a.md", anchor: { blockIndex: 2, offset: 3 }, head: { blockIndex: 2, offset: 7 } },
    ]);
    expect(draft.agents).toEqual([
      {
        taskId: "task-1",
        harness: "claude",
        label: "Tighten the intro",
        status: "editing",
        path: "notes/a.md",
        snippets: ["New text", "Old"],
      },
    ]);
  });

  it("sends each open document only its own carets, and only when they change", async () => {
    const t = setup();
    const port = createDocumentPort("/ws/a.md");
    const other = createDocumentPort("/ws/b.md");
    t.ports.push(port, other);
    const set = vi.spyOn(port.remoteCursors, "set");
    await t.poll();
    t.peerPublishes(
      "b",
      payloadOf("b", {
        cursors: [{ path: "a.md", anchor: { blockIndex: 1, offset: 2 } }],
        agents: [
          {
            taskId: "t",
            harness: "codex",
            label: "Agent",
            status: "editing",
            path: "a.md",
            anchor: { blockIndex: 0, offset: 1 },
          },
        ],
      }),
    );
    await t.poll();
    expect(port.remoteCursors.get()).toEqual([
      {
        holderId: "b",
        name: "User b",
        color: "#0090ff",
        anchor: { blockIndex: 1, offset: 2 },
        head: null,
      },
      {
        holderId: "b/t",
        name: "User b · codex",
        color: "#0090ff",
        anchor: { blockIndex: 0, offset: 1 },
        head: null,
        agent: { taskId: "t", harness: "codex", label: "Agent", status: "editing" },
      },
    ]);
    expect(other.remoteCursors.get()).toEqual([]);
    const calls = set.mock.calls.length;
    t.advance(500);
    await t.poll();
    expect(set.mock.calls.length).toBe(calls);
  });

  it("goodbye deletes its own ref, compare-and-swap on what it published", async () => {
    const t = setup();
    await t.poll();
    const own = t.remote.get(presenceRef("me"))!;
    await t.presence.goodbye();
    expect(t.deleted).toEqual([{ ref: presenceRef("me"), old: own }]);
    expect(t.remote.has(presenceRef("me"))).toBe(false);
    // Nothing published: nothing to delete.
    const fresh = setup();
    await fresh.presence.goodbye();
    expect(fresh.deleted).toEqual([]);
  });

  it("publishes over a ref left by an earlier run, taking its oid as the CAS's old", async () => {
    const t = setup();
    t.remote.set(presenceRef("me"), "left-over");
    await t.poll();
    expect(t.published).toHaveLength(1);
    expect(t.api.publishPresence).toHaveBeenCalledWith(
      expect.objectContaining({ old: "left-over" }),
    );
  });
});
