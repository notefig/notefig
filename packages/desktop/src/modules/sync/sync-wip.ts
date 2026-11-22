/**
 * Others' work in progress, read here (MET-273): a device's presence commit
 * holds the text of the files it holds claims in, as saved
 * (`sync-presence.ts`). For each file open in an editor here, this reads
 * the units each peer holds from that commit, for the editor to draw over
 * its own text (`sync-editor.ts`). Nothing here is written anywhere: the
 * branch brings the text for good once the peer commits it.
 *
 * A commit is read once per file: the next heartbeat is a new commit.
 */
import type { GitService } from "@notefig/git";
import type { ClaimHolder } from "./sync-claims";
import type { SyncPeer } from "./sync-machine";
import type { PeerUnit } from "./sync-units";

/** A unit a peer holds, as it has it now. */
export interface WipUnit extends PeerUnit {
  holder: ClaimHolder;
  /** What its claim names it by: as it was, as it landed, and now
   *  (`key`). Where its text matches no unit here, an earlier one does. */
  keys: string[];
}

export interface Wip {
  /** Read what `peers` are typing in `paths` (`/`-separated), the files
   *  open here. */
  refresh(peers: readonly SyncPeer[], paths: string[]): Promise<void>;
  /** What's to draw in `path`. */
  in(path: string): WipUnit[];
}

export function createWip(deps: {
  git: Pick<GitService, "readFile">;
  /** The units of a copy of a file that `keys` name, off the main thread. */
  peerUnits(markdown: string, keys: string[]): Promise<PeerUnit[]>;
}): Wip {
  let drawn = new Map<string, WipUnit[]>();
  /** By commit and file: a commit never changes. */
  let read = new Map<string, PeerUnit[]>();

  const unitsAt = async (oid: string, path: string, keys: string[]): Promise<PeerUnit[]> => {
    const id = `${oid}\u0000${path}`;
    const known = read.get(id);
    if (known) return known;
    const bytes = await deps.git.readFile({ ref: oid, filepath: path }).catch(() => null);
    const units = bytes ? await deps.peerUnits(new TextDecoder().decode(bytes), keys) : [];
    read.set(id, units);
    return units;
  };

  return {
    async refresh(peers, paths) {
      const open = new Set(paths);
      const next = new Map<string, WipUnit[]>();
      const kept = new Map<string, PeerUnit[]>();
      for (const peer of peers) {
        if (!peer.wip) continue;
        for (const claim of peer.claims) {
          if (!open.has(claim.path)) continue;
          // A claim's last key is what the unit says now, if it's still there.
          const current = claim.keys.at(-1);
          const keys = peer.claims.filter((c) => c.path === claim.path).flatMap((c) => c.keys.slice(-1));
          const units = await unitsAt(peer.wip, claim.path, keys);
          kept.set(`${peer.wip}\u0000${claim.path}`, units);
          const unit = units.find((candidate) => candidate.named === current);
          if (!unit) continue;
          const holder = { peer, agent: claim.agent };
          next.set(claim.path, [...(next.get(claim.path) ?? []), { ...unit, holder, keys: claim.keys }]);
        }
      }
      // What no peer holds any more is dropped.
      read = kept;
      drawn = next;
    },
    in: (path) => drawn.get(path) ?? [],
  };
}
