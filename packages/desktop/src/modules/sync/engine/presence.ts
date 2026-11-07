/**
 * Presence, the main thread's side (MET-272), part of the sync engine
 * (loaded only for a sync workspace). It decides when to publish and what
 * the others' presence means; the worker writes, reads and maps
 * (`sync-worker-presence.ts`).
 *
 * Driven by the engine's cycle: after each poll, `step(tips)`:
 *
 * 1. The poll's presence refs feed liveness (`presence-liveness.ts`):
 *    a device is live while its ref moved recently, as observed here.
 * 2. Any other live device → `peers: true` (the machine goes shared);
 *    none → back to solo once the last one is stale or gone.
 * 3. Live payloads that moved, or all of them when the branch head moved,
 *    are read and mapped onto the head in the worker; the peers go to the
 *    module (`presenceChanged`, the list UI) and each open document's
 *    channel gets its carets (`remoteCursors`, latest value) only when they
 *    changed.
 * 4. This device's own presence is published when due, in a request of
 *    its own: when it changed (at most every `PRESENCE_MIN_INTERVAL_*`) and
 *    otherwise as a heartbeat (`PRESENCE_HEARTBEAT_*`).
 *
 * The payload carries the user's name and colour, the carets the attached
 * editors reported (`SyncDocumentChannel.setCursor`, shared level only),
 * and this device's running agent sessions: rows from `core.agentStore`
 * plus what their live tool calls touch (`agent:tool-call`).
 *
 * `goodbye` deletes the ref (workspace close, sync off, page hide); a
 * device that crashes ages out on the others instead.
 */
import type { Hooks } from "@notefig/core";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { isMutatingToolCall } from "@notefig/widgets";
import {
  isActiveToolCall,
  toolCallLocations,
  toolCallSnippets,
} from "@/modules/agents/tool-call-locations";
import { resolveWorkspacePath } from "@/utils/fs";
import { path as pathutil } from "@/utils/path";
import type { SyncDocumentPort, SyncRemoteCursor } from "../document-channel";
import type { SyncCapabilities } from "../sync-machine";
import type {
  SyncPeer,
  SyncPresenceDraft,
  SyncPresenceRead,
  SyncRefTip,
  SyncWorkerApi,
} from "../sync-types";
import { createPresenceLiveness, type PresenceLiveness } from "./presence-liveness";
import { presenceDeviceOf, presenceRef, presenceSignature } from "./presence-payload";

/** A changed presence is published at most this often at the shared
 *  level (cursor moves), and this often in solo (agents coming and going). */
export const PRESENCE_MIN_INTERVAL_SHARED_MS = 1_000;
export const PRESENCE_MIN_INTERVAL_SOLO_MS = 5_000;
/** An unchanged presence is re-published (the ref moved) this often while
 *  shared and focused, and this often otherwise (solo, or the window in
 *  the background). Both well under `PRESENCE_STALE_MS`. */
export const PRESENCE_HEARTBEAT_FOCUSED_MS = 12_000;
export const PRESENCE_HEARTBEAT_IDLE_MS = 40_000;
/** How long a goodbye may hold up closing the workspace. */
export const PRESENCE_GOODBYE_TIMEOUT_MS = 2_000;
/** Task statuses that are presence: the session is doing something. */
const RUNNING = new Set(["running", "starting"]);

/** When a presence is due to be published. */
export function presenceDue(input: {
  now: number;
  /** When it was last published (null: never). */
  lastAt: number | null;
  changed: boolean;
  shared: boolean;
  focused: boolean;
}): boolean {
  if (input.lastAt === null) return true;
  const since = input.now - input.lastAt;
  const minInterval = input.shared ? PRESENCE_MIN_INTERVAL_SHARED_MS : PRESENCE_MIN_INTERVAL_SOLO_MS;
  if (input.changed && since >= minInterval) return true;
  const heartbeat =
    input.shared && input.focused ? PRESENCE_HEARTBEAT_FOCUSED_MS : PRESENCE_HEARTBEAT_IDLE_MS;
  return since >= heartbeat;
}

export interface PresenceDeps {
  workspacePath: string;
  deviceId: string;
  api: Pick<SyncWorkerApi, "publishPresence" | "deletePresence" | "readPresence">;
  hooks: Hooks;
  identity(): { name: string; color: string };
  capabilities(): SyncCapabilities;
  setPeersPresent(present: boolean): void;
  presenceChanged(peers: readonly SyncPeer[]): void;
  ports(): SyncDocumentPort[];
  agentTasks(): readonly AgentTaskRow[];
  isFocused(): boolean;
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
  liveness?: PresenceLiveness;
}

export interface Presence {
  /** Subscribe to the agent hooks. */
  start(): void;
  /** After a poll: liveness, levels, reads, the channels, then publish
   *  if due. `head`: the local branch tip. Never throws. */
  step(tips: readonly SyncRefTip[], head: string | null): Promise<void>;
  /** Delete this device's ref (bounded; best effort). */
  goodbye(): Promise<void>;
  /** Unsubscribe; clear the channels' carets. */
  stop(): void;
  /** The peers as last built. */
  peers(): readonly SyncPeer[];
}

type AgentActivity = { path?: string; snippets: string[]; editing: boolean };

/** What this device's agents are doing, from their live tool calls. */
function trackAgents(root: string, hooks: Hooks) {
  const activity = new Map<string, AgentActivity>();
  const tree = (path: string) => {
    const resolved = resolveWorkspacePath(root, path);
    if (!resolved.ok) return undefined;
    const relative = pathutil.relative(root, resolved.absolute);
    return relative ? pathutil.toTreePath(relative) : undefined;
  };
  const unsubscribe = [
    hooks.on("agent:tool-call", ({ taskId, workspacePath, toolCall }) => {
      if (pathutil.normalize(workspacePath) !== root) return;
      const path = toolCallLocations(toolCall).map(tree).find(Boolean);
      const active = isActiveToolCall(toolCall);
      const prior = activity.get(taskId);
      activity.set(taskId, {
        path: path ?? prior?.path,
        snippets: active ? toolCallSnippets(toolCall) : (prior?.snippets ?? []),
        editing: active && isMutatingToolCall(toolCall),
      });
    }),
    hooks.on("agent:turn-settled", ({ taskId }) => void activity.delete(taskId)),
  ];
  return {
    activity: (taskId: string) => activity.get(taskId),
    stop: () => unsubscribe.forEach((off) => off()),
  };
}

export function createPresence(deps: PresenceDeps): Presence {
  const root = pathutil.normalize(deps.workspacePath);
  const ownRef = presenceRef(deps.deviceId);
  const liveness = deps.liveness ?? createPresenceLiveness({ now: deps.now });
  let agents: ReturnType<typeof trackAgents> | null = null;
  /** Our own ref's oid on the remote, as last known (the CAS's old). */
  let ownRemote: string | null = null;
  let lastPublishedAt: number | null = null;
  let lastSignature: string | null = null;
  let seq = 0;
  /** Publish on the next step whatever the interval (a new peer). */
  let greet = false;
  /** Reads by device: the payload mapped at `head`. */
  const reads = new Map<string, { oid: string; head: string | null; read: SyncPresenceRead }>();
  let peers: readonly SyncPeer[] = [];
  let peersKey = "[]";
  let wasLive = new Set<string>();
  const portKeys = new WeakMap<SyncDocumentPort, string>();
  let stopped = false;

  const tree = (absolute: string) => {
    const relative = pathutil.relative(root, absolute);
    return relative ? pathutil.toTreePath(relative) : null;
  };
  const absolute = (treePath: string) => pathutil.join(root, pathutil.fromTreePath(treePath));

  const draft = (): SyncPresenceDraft => {
    const cursors = deps.ports().flatMap((port) => {
      const cursor = port.cursor.get();
      const path = tree(port.channel.path);
      return cursor && path ? [{ path, anchor: cursor.anchor, head: cursor.head }] : [];
    });
    const running = deps
      .agentTasks()
      .filter((task) => pathutil.normalize(task.workspacePath) === root && RUNNING.has(task.status));
    return {
      v: 1,
      user: deps.identity(),
      deviceId: deps.deviceId,
      seq,
      focused: deps.isFocused(),
      cursors,
      agents: running.map((task) => {
        const activity = agents?.activity(task.taskId);
        return {
          taskId: task.taskId,
          harness: task.harnessId,
          label: (task.title || task.harnessId).slice(0, 80),
          status: activity?.editing ? "editing" : "working",
          ...(activity?.path ? { path: activity.path, snippets: activity.snippets } : {}),
        };
      }),
    };
  };

  const publish = async () => {
    const next = draft();
    const signature = presenceSignature(next);
    const due =
      greet ||
      presenceDue({
        now: deps.now(),
        lastAt: lastPublishedAt,
        changed: signature !== lastSignature,
        shared: deps.capabilities().presence,
        focused: next.focused,
      });
    if (!due) return;
    next.seq = seq + 1;
    const result = await deps.api.publishPresence({ ref: ownRef, old: ownRemote, draft: next });
    if (!result.ok || result.value.status !== "published") return;
    seq = next.seq;
    greet = false;
    ownRemote = result.value.oid;
    lastPublishedAt = deps.now();
    lastSignature = signature;
  };

  const peerOf = (deviceId: string): SyncPeer | null => {
    const payload = reads.get(deviceId)?.read.payload;
    if (!payload) return null;
    return {
      deviceId,
      name: payload.user.name,
      color: payload.user.color,
      focused: payload.focused,
      cursors: payload.cursors.map((cursor) => ({ ...cursor, path: absolute(cursor.path) })),
      agents: payload.agents.map((agent) =>
        agent.path ? { ...agent, path: absolute(agent.path) } : agent,
      ),
    };
  };

  /** Read the live payloads that moved (all of them after the head did). */
  const refresh = async (live: string[], tipOf: Map<string, string>, head: string | null) => {
    const wanted = live.filter((deviceId) => {
      const known = reads.get(deviceId);
      return !known || known.oid !== tipOf.get(deviceId) || known.head !== head;
    });
    for (const deviceId of [...reads.keys()]) {
      if (!live.includes(deviceId)) reads.delete(deviceId);
    }
    if (wanted.length === 0) return;
    const result = await deps.api.readPresence({
      refs: wanted.map((deviceId) => ({ ref: presenceRef(deviceId), oid: tipOf.get(deviceId)! })),
    });
    if (!result.ok) return;
    for (const read of result.value) {
      const deviceId = presenceDeviceOf(read.ref);
      if (deviceId) reads.set(deviceId, { oid: read.oid, head, read });
    }
  };

  const cursorsFor = (path: string): SyncRemoteCursor[] =>
    peers.flatMap((peer) => [
      ...peer.cursors
        .filter((cursor) => cursor.path === path)
        .map((cursor) => ({
          holderId: peer.deviceId,
          name: peer.name,
          color: peer.color,
          anchor: cursor.anchor,
          head: cursor.head ?? null,
        })),
      ...peer.agents
        .filter((agent) => agent.path === path && agent.anchor)
        .map((agent) => ({
          holderId: `${peer.deviceId}/${agent.taskId}`,
          name: `${peer.name} · ${agent.harness}`,
          color: peer.color,
          anchor: agent.anchor!,
          head: null,
          agent: {
            taskId: agent.taskId,
            harness: agent.harness,
            label: agent.label,
            status: agent.status,
          },
        })),
    ]);

  /** Each open channel gets its carets, only when they changed. */
  const deliver = () => {
    for (const port of deps.ports()) {
      if (port.closed) continue;
      const cursors = cursorsFor(port.channel.path);
      const key = JSON.stringify(cursors);
      if (portKeys.get(port) === key) continue;
      portKeys.set(port, key);
      port.remoteCursors.set(cursors);
    }
  };

  const observe = (tips: readonly SyncRefTip[]) => {
    const others = new Map<string, string>();
    ownRemote = null;
    for (const tip of tips) {
      const deviceId = presenceDeviceOf(tip.ref);
      if (!deviceId) continue;
      if (deviceId === deps.deviceId) ownRemote = tip.oid;
      else others.set(deviceId, tip.oid);
    }
    liveness.observe(others);
    return others;
  };

  return {
    start() {
      agents = trackAgents(root, deps.hooks);
    },
    async step(tips, head) {
      if (stopped) return;
      try {
        const tipOf = observe(tips);
        const live = liveness.live();
        if (live.some((deviceId) => !wasLive.has(deviceId))) greet = true;
        wasLive = new Set(live);
        deps.setPeersPresent(live.length > 0);
        await refresh(live, tipOf, head);
        const next = live.map(peerOf).filter((peer): peer is SyncPeer => peer !== null);
        const key = JSON.stringify(next);
        if (key !== peersKey) {
          peersKey = key;
          peers = next;
          deps.presenceChanged(peers);
        }
        deliver();
        if (!stopped) await publish();
      } catch (error) {
        console.warn("[sync] presence step failed:", error);
      }
    },
    async goodbye() {
      const old = ownRemote;
      if (!old) return;
      ownRemote = null;
      let cancel = () => {};
      await Promise.race([
        deps.api.deletePresence({ ref: ownRef, old }).catch(() => undefined),
        new Promise<void>((resolve) => {
          cancel = deps.setTimer(resolve, PRESENCE_GOODBYE_TIMEOUT_MS);
        }),
      ]);
      cancel();
    },
    stop() {
      stopped = true;
      agents?.stop();
      agents = null;
      for (const port of deps.ports()) {
        if (!port.closed && portKeys.has(port)) port.remoteCursors.set([]);
      }
    },
    peers: () => peers,
  };
}
