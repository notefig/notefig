/**
 * Work in progress (MET-273): a device's presence commit holds the text of
 * the files it holds claims in, as saved (`sync-presence.ts`).
 *
 * - This device's (`createOwnWip`): those files, for its heartbeat, with
 *   each claim also named by what its unit says on the branch, the copy
 *   the others have.
 * - The others' (`createWip`): for each file open in an editor here, the
 *   units each peer holds, read from its commit, for the editor to draw
 *   over its own text (`sync-editor.ts`). A commit is read once per file:
 *   the next heartbeat is a new commit.
 *
 * Nothing here is written anywhere: the branch brings the text for good
 * once its device commits it.
 */
import type { GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { branchKeys, type ClaimHolder, type Claims } from "./sync-claims";
import type { SyncPeer } from "./sync-machine";
import { unitIndex, type FileUnit, type PeerUnit } from "./sync-units";

/** A file as the heartbeat puts it in its tree. */
export interface WipFile {
  filepath: string;
  bytes: Uint8Array;
}

export interface OwnWip {
  /** The files among `paths` (`/`-separated) as saved now, edits still in
   *  an editor saved first. A file the excludes keep out of every commit
   *  stays out of this one too. */
  files(paths: string[]): Promise<WipFile[]>;
}

export function createOwnWip(deps: {
  git: Pick<GitService, "isIgnored" | "readFile">;
  fs: Pick<FileSystemSurface, "readBinaryFiles">;
  claims: Pick<Claims, "branchHas">;
  /** The branch tip; null before its first commit. */
  head(): Promise<string | null>;
  /** An absolute path's `/`-separated path in the tree; null when sync
   *  leaves it out. */
  tree(absolute: string): string | null;
  absolute(path: string): string;
  /** Save what's still in an editor of `path` (absolute), if it's open. */
  flushEdits(path: string): Promise<void>;
  fileUnits(markdown: string): Promise<FileUnit[]>;
}): OwnWip {
  const decoder = new TextDecoder();
  /** The branch's copy of a file, cut into units: kept until it changes. */
  const branchUnits = new Map<string, { text: string; units: FileUnit[] }>();

  /** Name each unit this device holds in `path` by what it says on the
   *  branch too, `text` being what it says here: the others' copy is the
   *  branch, and this one may already be typing past it. */
  const nameOnBranch = async (path: string, text: string) => {
    const tip = await deps.head();
    const bytes = tip ? await deps.git.readFile({ ref: tip, filepath: path }).catch(() => null) : null;
    if (!bytes) return;
    const branchText = decoder.decode(bytes);
    let known = branchUnits.get(path);
    if (known?.text !== branchText) branchUnits.set(path, (known = { text: branchText, units: await deps.fileUnits(branchText) }));
    const here = await deps.fileUnits(text);
    const keys = branchKeys(known.units, here);
    // A claim's key may name its neighbours as they were: found as any is.
    const index = unitIndex(here.map((unit) => unit.key));
    deps.claims.branchHas(path, (key) => keys.get(index.resolve(key) ?? ""));
  };

  return {
    async files(paths) {
      const synced: string[] = [];
      for (const path of paths) if (!(await deps.git.isIgnored(path))) synced.push(path);
      await Promise.all(synced.map((path) => deps.flushEdits(deps.absolute(path))));
      const { succeeded } = await deps.fs.readBinaryFiles(synced.map(deps.absolute));
      const files = succeeded.flatMap(({ path, data }) => {
        const filepath = deps.tree(path);
        return filepath ? [{ filepath, bytes: data }] : [];
      });
      for (const { filepath, bytes } of files) await nameOnBranch(filepath, decoder.decode(bytes));
      // A file no longer held isn't kept.
      for (const path of [...branchUnits.keys()]) if (!synced.includes(path)) branchUnits.delete(path);
      return files;
    },
  };
}

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
