/**
 * The solo sync engine for one workspace (MET-270): it decides when, and
 * `core.gitWorker` does the git work off the main thread (this file only
 * awaits it). Loaded on demand by `sync.ts`, so a workspace that doesn't
 * sync never loads it.
 *
 * Nothing runs per keystroke: saves reach it through `files:written`, the
 * watcher through `files:changed`. A cycle, serialized (a request during
 * one runs once after it):
 *
 * 1. commit what was written since the last cycle — once per sitting:
 *    after `IDLE_COMMIT_MS` without a save, on window blur, or on close;
 *    at start, a scan for edits made while closed;
 * 2. poll the branch (one ref advertisement);
 * 3. if the remote moved, fetch and take it in: a fast-forward, or the
 *    local commits replayed as one commit on the remote tip, so the branch
 *    stays linear. A file changed on both sides is merged
 *    (`sync-overlap.ts`): in the replay when both changes are committed,
 *    once its editor's save lands when unsaved edits held the remote's
 *    version back. What a collision replaced is flagged and kept, so one
 *    file never stops sync: a file that can't be merged, or committed (the
 *    excludes keep it out), takes the remote's version too;
 * 4. push if ahead, compare-and-swap against the polled tip. A refused
 *    push reruns the cycle (bounded, with jitter); a push with no answer
 *    may have landed, so the next poll comes soon.
 *
 * The same poll reads who else syncs the branch (`sync-presence.ts`), and a
 * settled cycle keeps this device's own presence fresh. While anyone else
 * does, sync is shared (MET-293): a poll a second, a commit two seconds
 * after the saves settle instead of once per sitting, each other's carets
 * in the open editors (`sync-editor.ts`), and claims on the units each one
 * is editing (`sync-claims.ts`), its user's and its agents' alike, which
 * travel in the same presence commit, with the text it's typing in them,
 * drawn in the others' open editors within a cycle (`sync-wip.ts`).
 *
 * Back after more than an hour away with local changes, or far apart from
 * the remote, it pauses before taking anything in until the user says go.
 */
import type { Hooks } from "@notefig/core";
import { GitError, isSshRemote, type GitRemote, type GitService } from "@notefig/git";
import { FsError, type FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { DocumentsApi } from "@/modules/documents";
import type { EditorsApi } from "@/modules/editors";
import type { WorkspaceFiles } from "@/modules/files";
import { sshProblemOf } from "@/modules/git-remote";
import { IGNORE_RULES } from "@/utils/ignore";
import type { MergedMarkdown } from "./sync-merge";
import { createOverlaps, swapsAmong, writeSynced } from "./sync-overlap";
import { path as pathutil } from "@/utils/path";
import { createPresence, presencePrefix } from "./sync-presence";
import { createSyncEditors } from "./sync-editor";
import { branchKeys, createClaims, editBetween, refusalMessage } from "./sync-claims";
import { unitIndex, type FileUnit, type PeerUnit } from "./sync-units";
import { createWip } from "./sync-wip";
import {
  IDLE_COMMIT_MS,
  SHARED_COMMIT_MS,
  pollInterval,
  isRunning,
  isShared,
  type SyncEvent,
  type SyncReturnSummary,
  type SyncState,
} from "./sync-machine";

export interface SyncAuthor {
  name: string;
  email: string;
}

export interface SyncEngineDeps {
  root: string;
  git: GitService;
  remote: GitRemote;
  branch: string;
  author: SyncAuthor;
  /** This clone's, for its presence ref. */
  deviceId: string;
  /** When this device last synced; null if never. */
  lastSyncedAt: number | null;
  /** Sync was just turned on: commit everything, not a scan. */
  fullScan: boolean;
  hooks: Hooks;
  documents: Pick<DocumentsApi, "write" | "read" | "hasUnsavedEdits">;
  /** Where the others' carets are drawn, while shared. */
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  fs: Pick<
    FileSystemSurface,
    "readDirectory" | "getMetadata" | "readBinaryFiles" | "writeBinaryFiles" | "deleteFiles" | "deleteDirectories"
  >;
  /** The markdown three-way merge (`sync-merge.ts`), off the main thread. */
  merge(base: string, ours: string, theirs: string): Promise<MergedMarkdown>;
  /** A markdown file's units as claims see them (`sync-units.ts`), off the
   *  main thread. */
  fileUnits(markdown: string): Promise<FileUnit[]>;
  /** The units of another device's copy that `keys` name, with their
   *  nodes (`sync-units.ts`), off the main thread. */
  peerUnits(markdown: string, keys: string[]): Promise<PeerUnit[]>;
  /** Save what's still in `path`'s editor (absolute), if it's open: the
   *  work in progress others see is the file as saved. */
  flushEdits(path: string): Promise<void>;
  /** A merge that threw: the remote's version stood in for it. */
  reportError(error: unknown): void;
  state(): SyncState;
  dispatch(event: SyncEvent): void;
  /** Keep the last successful sync (this device's file). */
  recordSynced(at: number): Promise<void>;
  /** Files held for unsaved edits and their bases, as last recorded. */
  held: Readonly<Record<string, string>>;
  /** Keep them (this device's file), so a restart merges them too. */
  recordHeld(held: Record<string, string>): Promise<void>;
  /** Another branch was checked out (a terminal, another app): this
   *  engine syncs `branch` only, so it hands back to be restarted. */
  branchChanged(): void;
  setTimer?: (run: () => void, ms: number) => () => void;
  onBlur?: (listener: () => void) => () => void;
  now?: () => number;
  random?: () => number;
}

export interface SyncEngine {
  syncNow(): Promise<void>;
  /** Leave a stop and go on (after `paused`, without asking again). */
  resume(): Promise<void>;
  /** Leave a stop on a branch that shares no history with this one: take
   *  the remote's version, keeping ours on a local ref. */
  takeRemote(): Promise<void>;
  /** Commit and push what's left (briefly), then stop. */
  stop(): Promise<void>;
  /** Claim what an agent's write to `path` touches, as this device's
   *  (`write` gets the file as it is now); a sentence saying why not, and
   *  that nothing was written, when another device holds any of it. */
  claimWrite(path: string, write: (current: string) => string): Promise<string | null>;
}

const MAX_PUSH_RETRIES = 3;
const UNKNOWN_PUSH_RECHECK_MS = 2_000;
const CLOSE_SYNC_MS = 5_000;
/** Away longer than this with local changes: ask before going on. */
export const OFFLINE_RETURN_MS = 60 * 60_000;
/** Files changed on both sides, at or past which sync asks anyway. */
export const LARGE_DIVERGENCE_FILES = 25;
const RECORD_SYNCED_EVERY_MS = 5 * 60_000;
/** Files changed this long before the last sync still count in a scan
 *  (mtime granularity; both times are this machine's clock). */
const SCAN_SLACK_MS = 2_000;
/** The same against a commit's time, which came from another clock. */
const COMMIT_SCAN_SLACK_MS = 120_000;
const METADATA_BATCH = 500;
const SUMMARY_DEPTH = 200;
/** A held file was saved: settle it about this soon, not a sitting later. */
const HELD_SETTLE_MS = 500;
/** Files listed as replaced when the remote's version is taken whole. */
const MAX_REPLACED_LISTED = 50;
const MARKDOWN = /\.(md|markdown)$/i;
/** git's folder and the app's never sync, but for the project's config. */
const NEVER = /^(\.git(\/|$)|\.notefig(\/(?!config\.json$)|$))/;

/** A pull that moved the branch, and the files written so far. */
interface Move {
  from: string;
  to: string;
  done: Set<string>;
  /** Tried before: a file not written yet may have been saved since. */
  started?: boolean;
}

/** Raised to end a cycle whose stop was already dispatched. */
class CycleStop extends Error {}

/** `git`, refusing every call once `closed()`: a cycle left running past
 *  close's deadline ends at its next git call, whatever step it's on. */
function closable(git: GitService, closed: () => boolean): GitService {
  return new Proxy(git, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (closed()) throw new CycleStop();
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** A remote refused the push because it moved. */
const PUSH_REFUSALS = new Set(["NotFastForward", "RefConflict", "PushRejected"]);

/** SSH failures only the user can fix: a key, a host key, ssh itself. */
const SSH_ACTIONS = new Set(["AuthRequired", "AuthFailed", "RepoNotFound", "HostUnverified", "UnsupportedOperation"]);

export function faultOf(error: unknown, url: string): SyncEvent {
  const code = error instanceof GitError ? error.code : "Unknown";
  const sshProblem = isSshRemote(url) ? sshProblemOf(code, url) : undefined;
  if (sshProblem) return { type: "failed", fault: SSH_ACTIONS.has(code) ? "auth-error" : "offline", detail: sshProblem };
  const detail = error instanceof Error ? error.message : String(error);
  if (code === "AuthRequired" || code === "AuthFailed") return { type: "failed", fault: "auth-error", detail };
  if (code === "RepoNotFound") {
    return { type: "failed", fault: "auth-error", detail: "The repository was not found, or the credential can't see it." };
  }
  if (code === "Throttled") return { type: "failed", fault: "throttled", detail };
  return { type: "failed", fault: "offline", detail };
}

/** `notefig: Ada edited notes.md, plan.md and 3 more`. */
export function commitMessage(name: string, paths: string[]): string {
  const names = paths.map((path) => path.split("/").pop() ?? path);
  const rest = names.length - 3;
  const list =
    rest > 0
      ? `${names.slice(0, 3).join(", ")} and ${rest} more`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : (names[0] ?? "files");
  return `notefig: ${name} edited ${list}`;
}

async function inBatches<T>(items: string[], run: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < items.length; at += METADATA_BATCH) {
    out.push(...(await run(items.slice(at, at + METADATA_BATCH))));
  }
  return out;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine & { start(): void } {
  const { root, remote, branch, author } = deps;
  /** Ends a cycle at its next git call once closed (`alive`). */
  const git = closable(deps.git, () => stopped);
  const branchRef = `refs/heads/${branch}`;
  const setTimer =
    deps.setTimer ??
    ((run, ms) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    });
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  /** Tree paths written since the last commit, or a scan / everything. */
  let dirty: Set<string> | "scan" | "all" = deps.fullScan ? "all" : "scan";
  /** The next cycle commits: a sitting ended, or sync just started. A
   *  poll alone only looks at the remote. */
  let commitDue = true;
  /** The remote tip already taken in (pulled or pushed). */
  let integrated: string | null = null;
  /** A pull that moved the branch but not every file yet: finished before
   *  anything else, so the stale files are never committed back. */
  let unfinished: Move | null = null;
  let lastSynced = deps.lastSyncedAt;
  let lastRecorded = lastSynced ?? 0;
  /** The user chose the remote's version over a branch with no shared
   *  history: the next pull takes it. */
  let takeRemoteOnce = false;
  let returnApproved = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let cancelIdle: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  /** When the poll set is due. */
  let pollAt = 0;
  const cleanups: (() => void)[] = [];

  const tree = (absolute: string): string | null => {
    const relative = pathutil.relative(root, absolute);
    if (!relative) return null;
    const path = pathutil.toTreePath(relative);
    return NEVER.test(path) ? null : path;
  };
  const absolute = (path: string) => pathutil.join(root, pathutil.fromTreePath(path));
  /** After close's deadline a cycle may still be awaiting a request: it
   *  ends at its next git call (`closable`) or file write instead of
   *  touching a closed workspace. Only what it was waiting on can finish. */
  const alive = () => {
    if (stopped) throw new CycleStop();
  };
  const stop = (event: SyncEvent): never => {
    deps.dispatch(event);
    throw new CycleStop();
  };
  const head = async () => (await git.log({ ref: branchRef, depth: 1 }).catch(() => []))[0]?.oid ?? null;
  const overlaps = createOverlaps({
    git,
    documents: deps.documents,
    fs: deps.fs,
    absolute,
    merge: deps.merge,
    reportError: deps.reportError,
    dispatch: deps.dispatch,
    held: deps.held,
    recordHeld: deps.recordHeld,
    alive,
    now,
  });
  const claims = createClaims({ deviceId: deps.deviceId, now, peers: () => deps.state().peers });
  /** The branch's copy of a file, cut into units: kept until it changes. */
  const branchUnits = new Map<string, { text: string; units: FileUnit[] }>();
  /** Name each unit this device holds in `path` by what it says on the
   *  branch too, `text` being what it says here: the others' copy is the
   *  branch, and this one may already be typing past it. */
  const nameOnBranch = async (path: string, text: string) => {
    const tip = await head();
    const bytes = tip ? await git.readFile({ ref: tip, filepath: path }).catch(() => null) : null;
    if (!bytes) return;
    const branchText = new TextDecoder().decode(bytes);
    let known = branchUnits.get(path);
    if (known?.text !== branchText) branchUnits.set(path, (known = { text: branchText, units: await deps.fileUnits(branchText) }));
    const here = await deps.fileUnits(text);
    const keys = branchKeys(known.units, here);
    // A claim's key may name its neighbours as they were: found as any is.
    const index = unitIndex(here.map((unit) => unit.key));
    claims.branchHas(path, (key) => keys.get(index.resolve(key) ?? ""));
  };
  /** What this device is typing in `paths`, for its presence. A file the
   *  excludes keep out of every commit stays out of this one too. */
  const wip = async (paths: string[]) => {
    const synced: string[] = [];
    for (const path of paths) if (!(await git.isIgnored(path))) synced.push(path);
    await Promise.all(synced.map((path) => deps.flushEdits(absolute(path))));
    const { succeeded } = await deps.fs.readBinaryFiles(synced.map(absolute));
    const files = succeeded.flatMap(({ path, data }) => {
      const filepath = tree(path);
      return filepath ? [{ filepath, bytes: data }] : [];
    });
    for (const { filepath, bytes } of files) await nameOnBranch(filepath, new TextDecoder().decode(bytes));
    for (const path of [...branchUnits.keys()]) if (!synced.includes(path)) branchUnits.delete(path);
    return files;
  };
  const presence = createPresence({
    claims: claims.published,
    wip,
    deviceId: deps.deviceId,
    author,
    git,
    remote,
    branch,
    now,
    state: deps.state,
    dispatch: deps.dispatch,
  });
  const typing = createWip({ git, peerUnits: deps.peerUnits });
  const editors = createSyncEditors({ editors: deps.editors, tree, onCursor: presence.setCursor, claims, wip: typing, setTimer });
  const markDirty = (paths: string[]) => {
    if (typeof dirty !== "string") for (const path of paths) dirty.add(path);
  };

  // --- Commit -------------------------------------------------------------

  /** Files that may have changed while the app was closed: written since
   *  the last commit, or tracked and gone. A listing and a metadata call
   *  per 500 files, instead of a whole-tree status that re-hashes every
   *  file of a fresh clone. Null without a commit: status walks it all. */
  const scan = async (): Promise<string[] | null> => {
    const [last] = await git.log({ depth: 1 }).catch(() => []);
    if (!last) return null;
    // Not the last commit's time alone: a fresh clone's files are all newer.
    const since =
      deps.lastSyncedAt !== null
        ? deps.lastSyncedAt - SCAN_SLACK_MS
        : last.commit.committer.timestamp * 1000 - COMMIT_SCAN_SLACK_MS;
    const listing = await deps.fs.readDirectory(root, {
      recursive: true,
      includeFiles: true,
      includeDirectories: false,
      ignore: IGNORE_RULES,
    });
    if (!listing.ok) return null;
    const onDisk = listing.value.map((entry) => entry.path);
    const changed = await inBatches(onDisk, async (batch) =>
      (await deps.fs.getMetadata(batch)).succeeded
        .filter((meta) => new Date(meta.modifiedAt).getTime() > since)
        .map((meta) => meta.path),
    );
    const listed = new Set(onDisk.map(tree));
    const unlisted = (await git.listFiles()).filter((path) => !listed.has(path));
    const gone = await inBatches(unlisted, async (batch) =>
      (await deps.fs.getMetadata(batch.map(absolute))).failed
        .filter((failure) => failure.type === "not_found")
        .map((failure) => failure.path),
    );
    return [...changed, ...gone].map(tree).filter((path): path is string => path !== null);
  };

  /** Stage `paths` by hashing them: status trusts the index's stat cache,
   *  which misses a same-size save within the same second. One `add` for
   *  all of them, since each call rewrites the whole index. */
  const stageByHash = async (written: string[]) => {
    // A path the excludes name (`.claude/` committed before sync) stays as
    // it is on the remote, written or deleted here.
    const paths: string[] = [];
    for (const filepath of written) if (!(await git.isIgnored(filepath))) paths.push(filepath);
    const gone = new Set(
      await inBatches(paths, async (batch) =>
        (await deps.fs.getMetadata(batch.map(absolute))).failed
          .filter((failure) => failure.type === "not_found")
          .map((failure) => tree(failure.path)),
      ),
    );
    const present = paths.filter((filepath) => !gone.has(filepath));
    if (present.length > 0) await git.add({ filepath: present });
    for (const filepath of paths) {
      if (gone.has(filepath)) await git.remove({ filepath });
    }
  };

  const commitStep = async () => {
    commitDue = false;
    if (typeof dirty !== "string" && dirty.size === 0) return;
    const taken = dirty;
    dirty = new Set();
    deps.dispatch({ type: "step", activity: "committing" });
    try {
      const listed = taken === "all" ? null : taken === "scan" ? await scan() : [...taken];
      if (listed?.length === 0) return;
      // A held file's disk copy is stale until its edits land (`overlaps`).
      if (listed) await stageByHash(listed.filter((path) => !overlaps.isHeld(path)));
      const all = await stageChanges(git, listed, overlaps.isHeld);
      if (all.length === 0) return;
      await git.commit({ message: commitMessage(author.name, all), author });
    } catch (error) {
      // Keep what wasn't committed for the next try.
      commitDue = true;
      dirty = typeof taken === "string" ? taken : new Set([...taken, ...(dirty as Set<string>)]);
      throw error;
    }
  };

  // --- Pull ---------------------------------------------------------------

  /** Files among `paths` whose worktree moved off the index: saved here
   *  since the index last took them. */
  const editedSince = async (paths: string[]) => {
    if (paths.length === 0) return [];
    const status = await git.status({ filepaths: paths });
    return [...status.unstaged.map((change) => change.path), ...status.untracked];
  };

  /** Files among `paths` with uncommitted edits, but for held ones. */
  const dirtyAmong = async (paths: string[]) => {
    if (paths.length === 0) return [];
    const status = await git.status({ filepaths: paths });
    const edited = new Set([...status.staged, ...status.unstaged].map((c) => c.path).concat(status.untracked));
    return paths.filter((path) => edited.has(path) && !overlaps.isHeld(path));
  };

  /** Write one file as it is at `to`; `held` when its editor keeps unsaved
   *  edits. Throws on a write the fs refused. */
  const applyFile = async (filepath: string, to: string): Promise<"written" | "deleted" | "held"> => {
    const bytes = await git.readFile({ ref: to, filepath });
    const path = absolute(filepath);
    alive();
    if (bytes !== null) return writeSynced(deps, path, bytes);
    // Deleted there, typed here: the edit stays, as in a merge. Deleted
    // under its editor, the save would bring the file back unannounced.
    if (deps.documents.hasUnsavedEdits(path)) return "held";
    const { failed } = await deps.fs.deleteFiles([path]);
    const refused = failed.find((failure) => failure.type !== "not_found");
    if (refused) throw new Error(`Couldn't delete ${filepath}: ${refused.message}`);
    return "deleted";
  };

  /** A path that's a file at `from` and a folder at `to`, or the other way
   *  round, and what's in its way on disk: the folder's files, or the file. */
  const swapAt = async (path: string, to: string) => {
    const becomesFile = (await git.readFile({ ref: to, filepath: path })) !== null;
    if (!becomesFile) return { path, becomesFile, inTheWay: [path] };
    const listing = await deps.fs.readDirectory(absolute(path), { recursive: true, includeFiles: true, includeDirectories: false, includeHidden: true });
    // Never cleared unread: what's only here would go unkept.
    if (!listing.ok && listing.error.type !== "not_found") throw new Error(`Couldn't read ${path}: ${listing.error.message}`);
    const files = listing.ok ? listing.value.map((entry) => tree(entry.path)) : [];
    return { path, becomesFile, inTheWay: files.filter((filepath): filepath is string => filepath !== null) };
  };

  /** Clear a swap's way, keeping (and flagging) what isn't `from`'s, since
   *  the move doesn't write over it. Returns the files it removed. */
  const clearSwap = async (
    { path, becomesFile, inTheWay }: Awaited<ReturnType<typeof swapAt>>,
    { from, to, done }: Move,
    listed: string[],
  ) => {
    await overlaps.keepFiles(inTheWay, from);
    alive();
    const { failed } = becomesFile
      ? await deps.fs.deleteDirectories([absolute(path)], { recursive: true })
      : await deps.fs.deleteFiles([absolute(path)]);
    const refused = failed.find((failure) => failure.type !== "not_found");
    if (refused) throw new Error(`Couldn't clear ${path}: ${refused.message}`);
    // Kept and gone: a save to one of them has nothing left to commit.
    if (typeof dirty !== "string") for (const filepath of inTheWay) dirty.delete(filepath);
    // The folder's files, or the file: already gone on disk.
    for (const filepath of listed) {
      if (becomesFile ? !filepath.startsWith(`${path}/`) : filepath !== path) continue;
      await git.unstage({ filepath, ref: to });
      done.add(filepath);
    }
    return inTheWay.map(absolute);
  };

  /** Clear the way of every swap among `changed`: the files removed, or
   *  null while an edit is on its way to one of them. The move then waits
   *  (`unfinished`), and a later cycle keeps the edit once it's on disk. */
  const clearSwaps = async (move: Move, changed: string[]): Promise<string[] | null> => {
    const swaps = [];
    for (const path of swapsAmong(changed)) swaps.push(await swapAt(path, move.to));
    if (swaps.some((swap) => swap.inTheWay.some((filepath) => deps.documents.hasUnsavedEdits(absolute(filepath))))) return null;
    const removed: string[] = [];
    for (const swap of swaps) removed.push(...(await clearSwap(swap, move, changed)));
    return removed;
  };

  /** Bring index and worktree from `from` to `to` for the files that
   *  differ; text is written through the documents write path, which holds
   *  back a file with unsaved edits. A held file, or one saved here during
   *  a retried move, is merged once its edits land (`overlaps.settle`). */
  const moveWorktree = async (move: Move) => {
    const { from, to, done } = move;
    const created: string[] = [];
    const deleted: string[] = [];
    const retry = move.started === true;
    move.started = true;
    const changed = (await git.changedFiles(from, to)).filter((path) => !NEVER.test(path) && !done.has(path));
    const cleared = await clearSwaps(move, changed);
    if (!cleared) return;
    deleted.push(...cleared);
    const remaining = changed.filter((path) => !done.has(path));
    const edited = new Set(retry ? await editedSince(remaining) : []);
    for (const filepath of remaining) {
      alive();
      // Held already: its save may have landed since it was settled, so
      // it's merged with this version too rather than written over.
      const outcome = edited.has(filepath) || overlaps.isHeld(filepath) ? "held" : await applyFile(filepath, to);
      if (outcome === "held") await overlaps.hold(filepath, from);
      else (outcome === "written" ? created : deleted).push(absolute(filepath));
      // Only once the file is on disk (or held): a failed write leaves the
      // index at the old version, and the cycle finishes the move
      // (`unfinished`) before it commits anything.
      await git.unstage({ filepath, ref: to });
      done.add(filepath);
    }
    unfinished = null;
    if (created.length > 0 || deleted.length > 0) {
      await deps.files.recordDiskChanges({ created, deleted });
      deps.hooks.emit("sync:remote-applied", { workspacePath: root, commit: to, paths: [...created, ...deleted] });
    }
  };

  /** The branch was rewritten, and the user chose its version: ours stays
   *  on a local ref, listed file by file. */
  const takeRemoteVersion = async (ours: string, theirs: string) => {
    const changed = await git.changedFiles(ours, theirs);
    // Edits no commit holds (a file the excludes keep out): kept as they are.
    await overlaps.keepFiles(await dirtyAmong(changed));
    const ref = await overlaps.keep(ours);
    const mine = new Set(await git.listFiles({ ref: ours }));
    await git.writeRef(branchRef, theirs);
    unfinished = { from: ours, to: theirs, done: new Set() };
    await moveWorktree(unfinished);
    integrated = theirs;
    const replaced = changed.filter((path) => mine.has(path) && !NEVER.test(path)).slice(0, MAX_REPLACED_LISTED);
    deps.dispatch({ type: "overwritten", items: replaced.map((path) => ({ path, text: null, recovery: `${ref}:${path}` })) });
  };

  /** No shared history: stop, or take the remote's version if the user
   *  chose it. */
  const unrelated = (ours: string, theirs: string) => {
    if (takeRemoteOnce) return takeRemoteVersion(ours, theirs);
    return stop({
      type: "diverged",
      detail: "The remote branch shares no history with this workspace: it was rewritten or force-pushed.",
    });
  };

  /** Files the remote changed that are saved here and not committed: true
   *  once they're committed, for the replay to merge. A second time, they
   *  were saved since that commit: held, as for unsaved edits, so they're
   *  merged with the remote's version from what they started from
   *  (`ours`). Or the excludes keep them out of every commit, so no merge
   *  can carry them: kept as they are and flagged, and the remote's
   *  version taken. */
  const commitEdited = async (remoteFiles: string[], ours: string, committed: boolean): Promise<boolean> => {
    const edited = await dirtyAmong(remoteFiles);
    if (edited.length === 0) return false;
    if (committed) {
      const excluded: string[] = [];
      for (const filepath of edited) {
        if (await git.isIgnored(filepath)) excluded.push(filepath);
        else await overlaps.hold(filepath, ours);
      }
      await overlaps.keepFiles(excluded);
      return false;
    }
    markDirty(edited);
    await commitStep();
    return true;
  };

  const fastForward = async (ours: string, theirs: string) => {
    await git.merge({ ours: branchRef, theirs, fastForwardOnly: true });
    unfinished = { from: ours, to: theirs, done: new Set() };
    await moveWorktree(unfinished);
  };

  /** The local commits since `base` as one commit on `theirs`, with the
   *  files both sides changed merged. */
  const replay = async (base: string, ours: string, theirs: string, remoteFiles: string[]) => {
    const localFiles = await git.changedFiles(base, ours);
    const local = new Set(localFiles);
    const lost: Awaited<ReturnType<typeof overlaps.mergeCommitted>> = [];
    try {
      for (const filepath of remoteFiles) {
        if (!local.has(filepath)) await git.unstage({ filepath, ref: theirs });
        else lost.push(...(await overlaps.mergeCommitted(filepath, base, ours, theirs)));
      }
      lost.push(...(await overlaps.yieldSwapped(swapsAmong(remoteFiles), localFiles, ours, theirs)));
    } catch (error) {
      // Nothing is committed yet: the index goes back to ours, as on disk.
      for (const filepath of [...remoteFiles, ...localFiles]) await git.unstage({ filepath, ref: ours }).catch(() => {});
      throw error;
    }
    await overlaps.flagReplaced(lost, ours);
    const replayed = await git.commit({ message: commitMessage(author.name, localFiles), author, parent: [theirs] });
    unfinished = { from: ours, to: replayed, done: new Set() };
    await moveWorktree(unfinished);
  };

  const pullStep = async (committed = false): Promise<void> => {
    deps.dispatch({ type: "step", activity: "pulling" });
    // Also moves refs/remotes/origin/<branch>, keeping a diverged tip reachable.
    const [fetched] = await git.fetchRefs(remote, [branchRef]);
    const theirs = fetched?.oid;
    if (!theirs) throw new GitError("RepoNotFound", "The remote branch is gone.");
    const ours = await head();
    if (!ours) throw new GitError("InvalidInput", "The branch has no commits.");
    const base = ours === theirs ? ours : await git.mergeBase(ours, theirs);
    if (!base) return unrelated(ours, theirs);
    if (base !== theirs) {
      const remoteFiles = await git.changedFiles(base, theirs);
      if (await commitEdited(remoteFiles, ours, committed)) return pullStep(true);
      if (base === ours) await fastForward(ours, theirs);
      else await replay(base, ours, theirs, remoteFiles);
    }
    integrated = theirs;
  };

  // --- Offline return -------------------------------------------------------

  /** Long away, or both sides moved since the last sync. */
  const mayAsk = (theirs: string, ours: string | null): ours is string => {
    if (returnApproved || !ours || theirs === ours) return false;
    const drifting = integrated !== null && ours !== integrated && theirs !== integrated;
    return drifting || awayMs() > OFFLINE_RETURN_MS;
  };
  const awayMs = () => (lastSynced === null ? 0 : now() - lastSynced);

  /** Back after a long time away, or far apart: ask before going on. */
  const checkReturn = async (theirs: string, ours: string | null) => {
    if (!mayAsk(theirs, ours)) return;
    const away = awayMs();
    const [fetched] = await git.fetchRefs(remote, [branchRef]);
    const summary = fetched?.oid ? await returnSummary(git, ours, fetched.oid, lastSynced) : null;
    if (!summary) return;
    const drift = summary.localFiles.length + summary.remoteFiles.length;
    if (away <= OFFLINE_RETURN_MS && drift < LARGE_DIVERGENCE_FILES) return;
    stop({ type: "paused", detail: "Waiting for your go after a long time away.", summary });
  };

  // --- Push and the cycle -----------------------------------------------------

  /** Push if ahead; true when the remote refused (it moved). */
  const pushStep = async (theirs: string | null): Promise<boolean> => {
    const ours = await head();
    if (!ours || ours === theirs || ours === integrated) return false;
    deps.dispatch({ type: "step", activity: "pushing" });
    try {
      // The branch only moves forward: never forced, only over the polled tip.
      await git.pushRef(remote, { ref: branchRef, oid: ours, expect: theirs });
      integrated = ours;
      return false;
    } catch (error) {
      if (error instanceof GitError && PUSH_REFUSALS.has(error.code)) return true;
      if (error instanceof GitError && error.code === "Network") {
        // It may have landed: look again soon instead of guessing.
        schedulePoll(UNKNOWN_PUSH_RECHECK_MS);
        return false;
      }
      throw error;
    }
  };

  /** The remote's tip is already in this branch (it was pushed from here,
   *  or pulled): nothing to fetch, only to push. Answered locally; false
   *  when the commit isn't here yet. */
  const behindOurs = async (theirs: string, ours: string | null) =>
    ours !== null && (await git.mergeBase(ours, theirs).catch(() => null)) === theirs;

  /** Poll, pull if the remote moved, push if ahead. */
  const reconcile = async (): Promise<boolean> => {
    const refs = await git.listRemoteRefs(remote, [branchRef, presencePrefix(branch)]);
    const solo = !isShared(deps.state());
    presence.observe(refs);
    // Someone came: what's waiting for the sitting to end goes now.
    if (solo && isShared(deps.state()) && pending()) again = commitDue = true;
    const theirs = refs.find((ref) => ref.ref === branchRef)?.oid ?? null;
    const ours = await head();
    if (theirs) await checkReturn(theirs, ours);
    if (theirs && (theirs === ours || (theirs !== integrated && (await behindOurs(theirs, ours))))) integrated = theirs;
    else if (theirs && theirs !== integrated) await pullStep();
    return pushStep(theirs);
  };

  /** Held files whose edits landed, merged: they commit in this cycle. */
  const settleHeld = async () => {
    const current = overlaps.size > 0 ? await head() : null;
    if (!current) return;
    const changed = await overlaps.settle(current);
    if (changed.length === 0) return;
    markDirty(changed);
    commitDue = true;
  };

  const markSynced = () => {
    returnApproved = false;
    lastSynced = now();
    // The scan after a restart starts from this, so never past unsaved work.
    if (pending() || lastSynced - lastRecorded < RECORD_SYNCED_EVERY_MS) return;
    lastRecorded = lastSynced;
    void deps.recordSynced(lastSynced).catch(() => {});
  };

  /** Claims while shared, after a cycle that began at `at`: what landed
   *  and what's done ends. Solo, nobody needs to see them. */
  const settleClaims = (at: number) => {
    if (!isShared(deps.state())) return claims.clear();
    if (!pending()) claims.landed(at, (path) => deps.documents.hasUnsavedEdits(absolute(path)));
    claims.expire();
  };

  /** This device's presence out, the others' in, with what they're typing
   *  in the files open here (drawn as the cycle ends), and the sweep. */
  const presenceStep = async () => {
    await presence.heartbeat();
    await presence.read();
    if (isShared(deps.state())) await typing.refresh(deps.state().peers, editors.paths());
    await presence.sweep();
  };

  const cycle = async () => {
    if (!isRunning(deps.state())) return;
    const startedAt = now();
    try {
      if ((await git.currentBranch()) !== branch) {
        // Its delete is sent before git closes; nothing waits for it.
        void presence.leave();
        stopped = true;
        deps.branchChanged();
        return;
      }
      if (unfinished) await moveWorktree(unfinished);
      // Still waiting on a save: nothing is committed over a stale worktree.
      if (unfinished) return;
      await settleHeld();
      if (commitDue) await commitStep();
      let refused = await reconcile();
      for (let retry = 0; refused && retry < MAX_PUSH_RETRIES && !stopped; retry++) {
        await new Promise<void>((resume) => setTimer(resume, 200 + random() * 800));
        refused = await reconcile();
      }
      if (refused) {
        deps.dispatch({ type: "failed", fault: "offline", detail: "The remote keeps moving; trying again soon." });
        return;
      }
      settleClaims(startedAt);
      await presenceStep();
      markSynced();
      deps.dispatch({ type: "settled" });
    } catch (error) {
      if (!(error instanceof CycleStop)) deps.dispatch(faultOf(error, remote.url));
    } finally {
      if (!stopped) editors.reconcile(deps.state());
    }
  };

  const schedulePoll = (ms?: number) => {
    cancelPoll?.();
    cancelPoll = null;
    if (stopped || !isRunning(deps.state())) return;
    const delay = ms ?? pollInterval(deps.state()) * (0.8 + random() * 0.4);
    pollAt = now() + delay;
    cancelPoll = setTimer(() => {
      cancelPoll = null;
      void syncNow(false);
    }, delay);
  };

  /** Run a cycle; `commit` ends the sitting, a poll leaves it running. */
  const syncNow = (commit = true): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (commit) {
      commitDue = true;
      cancelIdle?.();
      cancelIdle = null;
    }
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await cycle();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
      // A short recheck set during the cycle stays; a solo poll is brought
      // forward once someone comes.
      if (!cancelPoll || pollAt > now() + pollInterval(deps.state()) * 1.2) schedulePoll();
    });
    return running;
  };

  const written = (paths: string[]) => {
    const trees = paths.map(tree).filter((path): path is string => path !== null);
    if (trees.length === 0 || stopped) return;
    markDirty(trees);
    cancelIdle?.();
    // A held file's save is what its merge waits for.
    const settle = trees.some(overlaps.isHeld);
    const delay = settle ? HELD_SETTLE_MS : isShared(deps.state()) ? SHARED_COMMIT_MS : IDLE_COMMIT_MS;
    cancelIdle = setTimer(() => void syncNow(), delay);
  };
  const pending = () => typeof dirty === "string" || dirty.size > 0 || overlaps.size > 0;
  const onBlur =
    deps.onBlur ??
    ((listener: () => void) => {
      window.addEventListener("blur", listener);
      return () => window.removeEventListener("blur", listener);
    });

  return {
    start() {
      cleanups.push(
        deps.hooks.on("files:written", ({ paths, source }) => {
          if (source !== "sync") written(paths);
        }),
        deps.hooks.on("files:changed", ({ workspacePath, paths }) => {
          if (pathutil.normalize(workspacePath) === root) written(paths);
        }),
        onBlur(() => {
          if (pending()) void syncNow();
        }),
      );
      void syncNow();
    },
    syncNow: () => syncNow(),
    async claimWrite(absolutePath, write) {
      const path = tree(absolutePath);
      if (!path || !MARKDOWN.test(path) || stopped || !isShared(deps.state())) return null;
      // A file that isn't there yet is empty; any other failure to read it
      // can't be checked, so it isn't let through.
      const current = await deps.documents.read(absolutePath).catch((error: unknown) => {
        if (error instanceof FsError && error.type === "not_found") return "";
        throw error;
      });
      const [before, after] = await Promise.all([deps.fileUnits(current), deps.fileUnits(write(current))]);
      const index = unitIndex(before.map((unit) => unit.key));
      const refusal = claims.take(path, editBetween(before, after), true, index);
      if (refusal) return refusalMessage(path, refusal);
      // Others see it on the next poll, not a sitting later.
      void syncNow(false);
      return null;
    },
    async resume() {
      returnApproved = true;
      deps.dispatch({ type: "resume" });
      await syncNow();
    },
    async takeRemote() {
      takeRemoteOnce = true;
      returnApproved = true;
      deps.dispatch({ type: "resume" });
      try {
        await syncNow();
      } finally {
        takeRemoteOnce = false;
      }
    },
    async stop() {
      cancelIdle?.();
      // One deadline for the last push and the cycle in flight: closing
      // never waits on a slow request (an HTTPS one can take 120 s). The
      // cycle left running ends on its own, and starts nothing after.
      let cancelDeadline = () => {};
      const deadline = new Promise<void>((done) => (cancelDeadline = setTimer(done, CLOSE_SYNC_MS)));
      const last = pending() && isRunning(deps.state()) ? syncNow() : running;
      const leave = async () => {
        await last?.catch(() => {});
        await presence.leave();
      };
      await Promise.race([leave(), deadline]);
      cancelDeadline();
      stopped = true;
      cancelIdle?.();
      cancelPoll?.();
      editors.stop();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/** Stage what status reports among `paths` (all when null), but for the
 *  `held` files; the paths the commit will hold. `.gitignore` and the
 *  sync excludes apply. */
async function stageChanges(git: GitService, paths: string[] | null, held: (path: string) => boolean): Promise<string[]> {
  const status = await git.status(paths ? { filepaths: paths } : undefined);
  const add = status.untracked.filter((path) => !held(path));
  for (const change of status.unstaged) {
    // A tracked file the excludes name (`.claude/` committed before sync)
    // stays as it is on the remote.
    if (held(change.path) || (await git.isIgnored(change.path))) continue;
    if (change.type === "deleted") await git.remove({ filepath: change.path });
    else add.push(change.path);
  }
  if (add.length > 0) await git.add({ filepath: add });
  const after = await git.status(paths ? { filepaths: paths } : undefined);
  return after.staged.map((c) => c.path).filter((path) => !NEVER.test(path)).sort();
}

/** What changed on each side since the common commit, and who changed
 *  the remote; null when there is nothing local to ask about. */
async function returnSummary(
  git: GitService,
  ours: string,
  theirs: string,
  since: number | null,
): Promise<SyncReturnSummary | null> {
  const base = await git.mergeBase(ours, theirs);
  if (!base || base === ours) return null;
  const localFiles = await git.changedFiles(base, ours);
  const remoteFiles = base === theirs ? [] : await git.changedFiles(base, theirs);
  const log = await git.log({ ref: theirs, depth: SUMMARY_DEPTH }).catch(() => []);
  const end = log.findIndex((entry) => entry.oid === base);
  const people = [...new Set((end < 0 ? log : log.slice(0, end)).map((e) => e.commit.author.name))];
  return { since, localFiles, remoteFiles, people };
}
