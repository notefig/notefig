/**
 * Turns a pairing code into a live tunnel to a `notefig agent` worker so
 * the browser can spawn agents on that machine. The tunnel is global — it
 * isn't tied to a workspace; files stay with the browser's own fs adapter.
 * Persists the last pairing in KV so a reload reconnects automatically
 * (worker restarts mint new URLs by design → reconnect may fail, which is
 * a non-fatal "re-pair" prompt, never a thrown boot error).
 */
import {
  decodePairingCode,
  encodePairingCode,
  type WorkerInfo,
} from "@notefig/shared/tunnel";
import {
  getOrCreateKvCollection,
  readKv,
  removeKv,
  writeKv,
} from "@/utils/kv-store";
import { disposeAllWorkspaceTaskManagers } from "@/agent/agent-service";
import { tunnelConnection } from "./tunnel-connection";

export const TUNNEL_KV_NAMESPACE = "tunnel";
export const TUNNEL_PAIRING_KEY = "pairing";

export type StoredPairing = {
  /** The pairing code (base58 secret + base64url url) — re-derivable. */
  code: string;
  workerName: string;
  workspacePath: string;
  pairedAt: number;
};

let disconnectRegistered = false;

/**
 * Wire tunnel disconnect → the same teardown a desktop workspace close runs
 * (once). The socket dying kills every agent on the worker, so every live
 * task is disposed; sessionful ones demote to "restored" and revive on
 * reconnect via session/load — exactly the desktop-restart path (MET-54).
 * This runs in onDisconnect (before transport onClose listeners) so the
 * per-task close callbacks find their AgentTask already disposed and no-op.
 */
function ensureDisconnectHandler(): void {
  if (disconnectRegistered) return;
  disconnectRegistered = true;
  tunnelConnection.onDisconnect(async () => {
    await disposeAllWorkspaceTaskManagers();
  });
}

async function persistPairing(code: string, worker: WorkerInfo): Promise<void> {
  const stored: StoredPairing = {
    code,
    workerName: worker.name,
    workspacePath: worker.workspacePath,
    pairedAt: Date.now(),
  };
  await writeKv(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, stored);
}

export async function getStoredPairing(): Promise<StoredPairing | undefined> {
  return readKv<StoredPairing>(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY);
}

export async function forgetPairing(): Promise<void> {
  await removeKv(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY);
}

/**
 * Connect using a pairing code (from a pasted link/code or a stored
 * pairing). Returns the worker info (name + advertised harnesses). Rejects
 * on decode/handshake failure without persisting a bad pairing.
 */
export async function connectWithCode(code: string): Promise<WorkerInfo> {
  ensureDisconnectHandler();
  const { secret, url } = decodePairingCode(code);
  // A tunnel can only connect from "disconnected" — if one is already live
  // (or mid-handshake), tear it down first so re-pairing with a fresh code
  // just works instead of throwing "already connected".
  await ensureDisconnected();
  const worker = await tunnelConnection.connect({ secret, url });
  await persistPairing(code, worker);
  return worker;
}

/** Resolve once the tunnel is fully disconnected (closing it if needed). */
function ensureDisconnected(): Promise<void> {
  if (tunnelConnection.getState().status === "disconnected") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = tunnelConnection.subscribe(() => {
      if (tunnelConnection.getState().status === "disconnected") {
        unsubscribe();
        resolve();
      }
    });
    tunnelConnection.disconnect();
  });
}

/**
 * Parse a pairing code out of a URL fragment (`.../pair#<code>`), or return
 * null. The caller must scrub the fragment from history immediately after —
 * the secret must not linger in the address bar or history stack.
 */
export function pairingCodeFromHash(hash: string): string | null {
  const code = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!code) return null;
  try {
    decodePairingCode(code);
    return code;
  } catch {
    return null;
  }
}

/** Re-normalize a code for storage/QR (round-trips through decode/encode). */
export function normalizePairingCode(code: string): string {
  const { secret, url } = decodePairingCode(code);
  return encodePairingCode(secret, url);
}

/**
 * Boot-time auto-connect. Non-fatal: a failed reconnect leaves the tunnel
 * disconnected (the status surface offers "re-pair"), never throws.
 */
export async function autoConnectStoredPairing(): Promise<WorkerInfo | null> {
  const stored = await getStoredPairing();
  if (!stored) return null;
  try {
    return await connectWithCode(stored.code);
  } catch {
    return null;
  }
}

export function disconnectTunnel(): void {
  tunnelConnection.disconnect();
}

/**
 * Cross-tab sync: when another tab pairs (e.g. the tab the CLI opened), a tab
 * that is already open and still disconnected picks the pairing up and connects
 * too. Returns a cleanup fn.
 */
export function watchCrossTabPairing(): () => void {
  // Was a `storage` event on a hand-built localStorage key, which meant this
  // file had to mirror the browser adapter's key layout. Since MET-124 the
  // pairing lives in a persisted collection whose coordinator (BroadcastChannel
  // + Web Locks) already replicates another tab's commits into this one, so the
  // collection's own change stream is both the real signal and layout-free.
  const collection = getOrCreateKvCollection(TUNNEL_KV_NAMESPACE);
  const storedCode = () =>
    (collection.get(TUNNEL_PAIRING_KEY)?.value as StoredPairing | undefined)
      ?.code;

  let subscription: { unsubscribe: () => void } | null = null;
  let cancelled = false;

  // Subscribe only once the collection has hydrated. Otherwise the pairing this
  // tab already had on disk arrives as a change and reads as "another tab just
  // paired" — auto-connecting behind App.tsx's back, which deliberately skips
  // the stored reconnect when the load carried a deep-link code.
  void collection.preload().then(() => {
    if (cancelled) return;
    let lastSeen = storedCode();
    subscription = collection.subscribeChanges((changes) => {
      if (!changes.some((change) => change.key === TUNNEL_PAIRING_KEY)) return;
      const code = storedCode();
      const isNewPairing = code !== undefined && code !== lastSeen;
      lastSeen = code;
      // Only a disconnected tab follows along — a tab already on a tunnel must
      // not be yanked onto another one.
      if (!isNewPairing) return;
      if (tunnelConnection.getState().status !== "disconnected") return;
      void autoConnectStoredPairing();
    });
  });

  return () => {
    cancelled = true;
    subscription?.unsubscribe();
  };
}
