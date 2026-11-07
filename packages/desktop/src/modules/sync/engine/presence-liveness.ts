/**
 * Liveness by observation (MET-266 decision 7): a device's presence counts
 * as live while its ref has moved recently *as this client saw it*. Each
 * poll's presence refs are compared with the last; a ref whose oid changed
 * (or that appeared) is stamped with the local clock. Nothing in a payload
 * is read for this — a forged or skewed timestamp in it can't keep a
 * device alive, and clock skew between devices doesn't matter.
 *
 * Refs already there on this client's first poll are dormant: they may be
 * left over from a crash, so they only count once they move. A device that
 * sees a new peer republishes at once (`presence.ts`), so two devices that
 * start at the same time still find each other within a poll or two.
 */

/**
 * How long a ref may stand still before its device counts as gone. It has
 * to outlast the slowest heartbeat (`PRESENCE_HEARTBEAT_IDLE_MS`) plus the
 * slowest healthy poll (solo, 12 s + 20% jitter) with room to spare.
 */
export const PRESENCE_STALE_MS = 75_000;

export interface PresenceLiveness {
  /** One poll's presence refs of the other devices (device id → oid). */
  observe(tips: ReadonlyMap<string, string>): void;
  /** The devices live now. */
  live(): string[];
  /** When the device's ref was last seen to move (local clock), or null. */
  changedAt(deviceId: string): number | null;
}

export function createPresenceLiveness(
  options: { now?: () => number; staleMs?: number } = {},
): PresenceLiveness {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? PRESENCE_STALE_MS;
  const seen = new Map<string, { oid: string; changedAt: number | null }>();
  let first = true;

  return {
    observe(tips) {
      const at = now();
      for (const [deviceId, oid] of tips) {
        const prior = seen.get(deviceId);
        if (!prior) seen.set(deviceId, { oid, changedAt: first ? null : at });
        else if (prior.oid !== oid) seen.set(deviceId, { oid, changedAt: at });
      }
      for (const deviceId of [...seen.keys()]) {
        // A deleted ref is a device that said goodbye.
        if (!tips.has(deviceId)) seen.delete(deviceId);
      }
      first = false;
    },
    live() {
      const at = now();
      return [...seen]
        .filter(([, entry]) => entry.changedAt !== null && at - entry.changedAt < staleMs)
        .map(([deviceId]) => deviceId);
    },
    changedAt: (deviceId) => seen.get(deviceId)?.changedAt ?? null,
  };
}
