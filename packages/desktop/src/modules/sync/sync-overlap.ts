/**
 * Files both sides changed (MET-271), settled in one place whichever way
 * the overlap came:
 *
 * - **In a replay**: local commits and the branch both changed a file.
 *   `mergeCommitted` merges the three versions and stages the result for
 *   the replay commit.
 * - **Held**: the branch changed a file whose editor had unsaved edits, so
 *   sync's write was held back (or a retried pull found the file saved
 *   since). `hold` keeps the file's base, what its edits started from,
 *   and records it so a restart keeps it too. Once the edits are on disk,
 *   `settle` merges them with the branch's version. Until then the file
 *   stays out of every commit, so its stale copy never reverts the branch.
 *
 * - **Swapped**: a path became a folder on one side and stayed a file on
 *   the other. The branch's side has the path; ours is flagged.
 *
 * Markdown is merged by `sync-merge.ts`, in the markdown worker; any other
 * file takes the branch's version, as does a file whose merge threw (a
 * bug, reported). Whatever of ours a merge replaces is flagged
 * (`overwritten`) and kept on a local ref that's never pushed: one file's
 * collision never stops sync.
 */
import type { GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { DocumentsApi } from "@/modules/documents";
import type { MergedMarkdown } from "./sync-merge";
import type { SyncEvent } from "./sync-machine";

export interface OverlapDeps {
  git: GitService;
  documents: Pick<DocumentsApi, "write" | "hasUnsavedEdits">;
  fs: Pick<FileSystemSurface, "readBinaryFiles" | "writeBinaryFiles">;
  absolute(path: string): string;
  /** The markdown merge; where it collides, the units of ours the keys in
   *  `won` name stand. */
  merge(base: string, ours: string, theirs: string, won?: string[]): Promise<MergedMarkdown>;
  /** The keys of the units of `filepath` this device won from another that
   *  claimed them too (`Claims.won`). */
  wonKeys(filepath: string): Promise<string[]>;
  /** A merge that threw: a bug to hear about, not the user's to fix. */
  reportError(error: unknown): void;
  dispatch(event: SyncEvent): void;
  /** Held files and their bases (path → blob oid), as last recorded. */
  held: Readonly<Record<string, string>>;
  recordHeld(held: Record<string, string>): Promise<void>;
  /** Throws once the workspace closed: called before each file write. */
  alive(): void;
  now(): number;
}

/** Our text a merge replaced; null for a file that isn't text. */
interface Lost {
  path: string;
  text: string | null;
}

const MARKDOWN = /\.(md|markdown)$/i;
export const RECOVERY_PREFIX = "refs/notefig/recovery/";
const MAX_RECOVERY_REFS = 50;

/** A file's text; null when it isn't UTF-8 text. */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Put a file's bytes on disk the way sync does: text through the
 *  documents write path, which holds back a file with unsaved edits
 *  (`held`); anything else straight to the file. */
export async function writeSynced(
  deps: Pick<OverlapDeps, "documents" | "fs">,
  path: string,
  bytes: Uint8Array,
): Promise<"written" | "held"> {
  const text = asText(bytes);
  if (text !== null) return deps.documents.write(path, text, { source: "sync" });
  const { failed } = await deps.fs.writeBinaryFiles([{ path, data: bytes }]);
  if (failed[0]) throw new Error(`Couldn't write ${path}: ${failed[0].message}`);
  return "written";
}

export function createOverlaps(deps: OverlapDeps) {
  const { git } = deps;
  const held = new Map(Object.entries(deps.held));
  const encoder = new TextEncoder();

  /** Our version merged with the branch's: the bytes to keep (null: the
   *  branch's stand), and what of ours they replace. */
  const combine = async (filepath: string, base: Uint8Array | null, ours: Uint8Array, theirs: Uint8Array) => {
    const mine = asText(ours);
    const incoming = asText(theirs);
    if (!MARKDOWN.test(filepath) || mine === null || incoming === null) {
      return { bytes: null, lost: [{ path: filepath, text: mine }] };
    }
    const from = (base && asText(base)) ?? "";
    let merged: MergedMarkdown;
    try {
      merged = await deps.merge(from, mine, incoming);
      // Races this device won: those units of ours stand, and what they
      // replace is the other device's, which stays in the branch's history.
      const won = merged.overwritten.length > 0 ? await deps.wonKeys(filepath) : [];
      if (won.length > 0) merged = await deps.merge(from, mine, incoming, won);
    } catch (error) {
      deps.reportError(error);
      return { bytes: null, lost: [{ path: filepath, text: mine }] };
    }
    const bytes = merged.text === incoming ? null : encoder.encode(merged.text);
    return { bytes, lost: merged.overwritten.map((text): Lost => ({ path: filepath, text })) };
  };

  const stage = async (filepath: string, bytes: Uint8Array, modeFrom: string) => {
    await git.stageBlob({ filepath, oid: await git.writeBlob(bytes), modeFrom });
  };

  /** Point a local-only ref at `oid`; the newest `MAX_RECOVERY_REFS` stay. */
  const keep = async (oid: string): Promise<string> => {
    const ref = `${RECOVERY_PREFIX}${deps.now()}-${oid.slice(0, 8)}`;
    await git.writeRef(ref, oid);
    const refs = await git.listRefs(RECOVERY_PREFIX);
    for (const old of refs.slice(0, -MAX_RECOVERY_REFS)) await git.deleteRef(old);
    return ref;
  };

  const write = (filepath: string, bytes: Uint8Array) => {
    deps.alive();
    return writeSynced(deps, deps.absolute(filepath), bytes);
  };

  const readDisk = async (filepath: string): Promise<Uint8Array | null> => {
    const { succeeded, failed } = await deps.fs.readBinaryFiles([deps.absolute(filepath)]);
    if (succeeded[0]) return succeeded[0].data;
    if (failed[0]?.type === "not_found") return null;
    throw new Error(`Couldn't read ${filepath}: ${failed[0]?.message}`);
  };

  /** A held file's saved edits merged with the branch's version (null:
   *  the branch's stands). Without its base (a blob pruned since), a merge
   *  can't tell edits from text: the branch's version stands, and ours is
   *  flagged whole. */
  const mergeSaved = (filepath: string, base: Uint8Array | null, disk: Uint8Array, theirs: Uint8Array) =>
    base ? combine(filepath, base, disk, theirs) : Promise.resolve({ bytes: null, lost: [{ path: filepath, text: asText(disk) }] });

  /** Put a held file's merge in place: true when it has something to
   *  commit. Typing again holds the write back: the merge then goes in
   *  through the index, and the edits on top of this save meet it next.
   *  Not for a file the excludes keep out, which no commit takes: its next
   *  save is merged from the same base again. */
  const applyMerged = async (filepath: string, disk: Uint8Array, bytes: Uint8Array | null, theirs: Uint8Array, head: string) => {
    if ((await write(filepath, bytes ?? theirs)) === "written") {
      held.delete(filepath);
      return true;
    }
    if (await git.isIgnored(filepath)) return false;
    held.set(filepath, await git.writeBlob(disk));
    if (!bytes) return false;
    await stage(filepath, bytes, head);
    return true;
  };

  /** One held file: true when it now has something to commit. */
  const settleOne = async (filepath: string, baseOid: string, head: string): Promise<boolean> => {
    // Gone from the branch (or a folder there now), or from disk: what's
    // on disk is the last word (an edit against a delete keeps the edit; a
    // delete here is the user's).
    const theirs = await git.readFile({ ref: head, filepath });
    // Deleted there, its edit still saving here: what's on disk is stale.
    if (theirs === null && deps.documents.hasUnsavedEdits(deps.absolute(filepath))) return false;
    const [disk, base] = theirs ? await Promise.all([readDisk(filepath), git.readFile({ ref: baseOid, filepath: "" })]) : [null, null];
    if (theirs === null || disk === null) {
      held.delete(filepath);
      return true;
    }
    if ((base && sameBytes(disk, base)) || sameBytes(disk, theirs)) {
      // Nothing saved over the base yet: try the branch's version again.
      if ((await write(filepath, theirs)) === "written") held.delete(filepath);
      return false;
    }
    const { bytes, lost } = await mergeSaved(filepath, base, disk, theirs);
    // Saved again during the merge: this result is stale, and the next
    // round merges the newer save.
    const latest = await readDisk(filepath);
    if (!latest || !sameBytes(latest, disk)) return false;
    if (lost.length > 0) {
      const ref = await keep(await git.writeBlob(disk));
      deps.dispatch({ type: "overwritten", items: lost.map((item) => ({ ...item, recovery: ref })) });
    }
    return applyMerged(filepath, disk, bytes, theirs, head);
  };

  return {
    /** Whether a held file's disk copy is stale: never stage it. */
    isHeld: (filepath: string) => held.has(filepath),
    get size() {
      return held.size;
    },

    /** A file both a replay's local commits and the branch changed: stage
     *  what the replay commit takes. What of ours it replaces comes back,
     *  for `flagReplaced`. */
    async mergeCommitted(filepath: string, base: string, ours: string, theirs: string): Promise<Lost[]> {
      const [b, o, t] = await Promise.all([base, ours, theirs].map((ref) => git.readFile({ ref, filepath })));
      // Deleted on the branch, edited here: the edit stays (the index has it).
      if (t === null) return [];
      // Deleted here, edited on the branch: the edit stays too.
      if (o === null || sameBytes(o, t)) {
        await git.unstage({ filepath, ref: theirs });
        return [];
      }
      const { bytes, lost } = await combine(filepath, b, o, t);
      if (bytes) await stage(filepath, bytes, theirs);
      else await git.unstage({ filepath, ref: theirs });
      return lost;
    },

    /** A replay's paths that became a folder on the branch where ours
     *  has a file, or a file where ours has files in a folder: the
     *  branch's stand in the index, and ours come back, for
     *  `flagReplaced`. */
    async yieldSwapped(swapped: string[], localFiles: string[], ours: string, theirs: string): Promise<Lost[]> {
      const lost: Lost[] = [];
      for (const path of swapped) {
        const becomesFile = (await git.readFile({ ref: theirs, filepath: path })) !== null;
        const inTheWay = localFiles.filter((filepath) => (becomesFile ? filepath.startsWith(`${path}/`) : filepath === path));
        for (const filepath of inTheWay) {
          const bytes = await git.readFile({ ref: ours, filepath });
          await git.unstage({ filepath, ref: theirs });
          if (bytes) lost.push({ path: filepath, text: asText(bytes) });
        }
      }
      return lost;
    },

    /** Flag what a replay replaced, kept whole on a ref to our commit. */
    async flagReplaced(lost: Lost[], ours: string) {
      if (lost.length === 0) return;
      const ref = await keep(ours);
      deps.dispatch({ type: "overwritten", items: lost.map((item) => ({ ...item, recovery: `${ref}:${item.path}` })) });
    },

    /** Our whole side, before something replaces it outright; the ref. */
    keep,

    /** Files about to be replaced whose edits no commit holds: each kept
     *  as it is on disk, and flagged; with `unlessAt`, only those that
     *  differ from their version there. */
    async keepFiles(filepaths: string[], unlessAt?: string) {
      const items = [];
      for (const filepath of filepaths) {
        const disk = await readDisk(filepath);
        if (!disk) continue;
        const known = unlessAt ? await git.readFile({ ref: unlessAt, filepath }) : null;
        if (known && sameBytes(disk, known)) continue;
        items.push({ path: filepath, text: asText(disk), recovery: await keep(await git.writeBlob(disk)) });
      }
      if (items.length > 0) deps.dispatch({ type: "overwritten", items });
    },

    /** The branch moved `filepath` to a version its editor's unsaved edits
     *  don't have: keep what they started from, as it is at `from`. */
    async hold(filepath: string, from: string) {
      if (held.has(filepath)) return;
      const bytes = await git.readFile({ ref: from, filepath });
      held.set(filepath, await git.writeBlob(bytes ?? new Uint8Array()));
      await deps.recordHeld(Object.fromEntries(held));
    },

    /** Merge each held file whose edits are on disk now with the branch's
     *  version (`head`); the files that have something to commit. */
    async settle(head: string): Promise<string[]> {
      if (held.size === 0) return [];
      const before = JSON.stringify([...held]);
      const changed: string[] = [];
      try {
        for (const [filepath, baseOid] of [...held]) {
          if (await settleOne(filepath, baseOid, head)) changed.push(filepath);
        }
      } finally {
        if (JSON.stringify([...held]) !== before) await deps.recordHeld(Object.fromEntries(held));
      }
      return changed;
    },
  };
}

export type Overlaps = ReturnType<typeof createOverlaps>;

/** Paths among a change's that were a file on one side and a folder on
 *  the other: `changedFiles` lists them along with the files in the
 *  folder. */
export function swapsAmong(paths: string[]): string[] {
  const listed = new Set(paths);
  const swapped = new Set<string>();
  for (const path of paths) {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      if (listed.has(path.slice(0, at))) swapped.add(path.slice(0, at));
    }
  }
  return [...swapped];
}
