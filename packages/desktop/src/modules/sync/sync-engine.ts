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
 *    local commits replayed as one commit on the remote tip when they
 *    touch other files, so the branch stays linear. Files changed on both
 *    sides stop at `diverged` (the shared level brings the merge);
 * 4. push if ahead, compare-and-swap against the polled tip. A refused
 *    push reruns the cycle (bounded, with jitter); a push with no answer
 *    may have landed, so the next poll comes soon.
 *
 * Back after more than an hour away with local changes, or far apart from
 * the remote, it pauses before taking anything in until the user says go.
 */
import type { Hooks } from "@notefig/core";
import { GitError, isSshRemote, type GitRemote, type GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { DocumentsApi } from "@/modules/documents";
import type { WorkspaceFiles } from "@/modules/files";
import { sshProblemOf } from "@/modules/git-remote";
import { IGNORE_RULES } from "@/utils/ignore";
import { path as pathutil } from "@/utils/path";
import {
  IDLE_COMMIT_MS,
  pollInterval,
  isRunning,
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
  /** When this device last synced; null if never. */
  lastSyncedAt: number | null;
  /** Sync was just turned on: commit everything, not a scan. */
  fullScan: boolean;
  hooks: Hooks;
  documents: Pick<DocumentsApi, "write">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  fs: Pick<FileSystemSurface, "readDirectory" | "getMetadata" | "writeBinaryFiles" | "deleteFiles">;
  state(): SyncState;
  dispatch(event: SyncEvent): void;
  /** Keep the last successful sync (this device's file). */
  recordSynced(at: number): Promise<void>;
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
  /** Leave a stop: after `diverged`, the next cycle keeps local files
   *  where both sides changed; after `paused`, it goes on. */
  resume(): Promise<void>;
  /** Commit and push what's left (briefly), then stop. */
  stop(): Promise<void>;
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
/** git's folder and the app's never sync, but for the project's config. */
const NEVER = /^(\.git(\/|$)|\.notefig(\/(?!config\.json$)|$))/;

/** A pull that moved the branch: the files written so far, and those held
 *  for unsaved edits (asked about once every file is done). */
interface Move {
  from: string;
  to: string;
  done: Set<string>;
  held: string[];
}

/** Raised to end a cycle whose stop was already dispatched. */
class CycleStop extends Error {}

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
  // A change only a terminal can take in (a mode, a file swapped with a
  // folder): the user's to sort out.
  if (code === "PullRefused") return { type: "diverged", detail };
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
  const { root, git, remote, branch, author } = deps;
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
  let keepLocalOnce = false;
  let returnApproved = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let cancelIdle: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  const cleanups: (() => void)[] = [];

  const tree = (absolute: string): string | null => {
    const relative = pathutil.relative(root, absolute);
    if (!relative) return null;
    const path = pathutil.toTreePath(relative);
    return NEVER.test(path) ? null : path;
  };
  const absolute = (path: string) => pathutil.join(root, pathutil.fromTreePath(path));
  /** After close's deadline a cycle may still be awaiting a request: it
   *  ends before its next step that writes (a fetch into `.git`, a commit,
   *  the branch moving, a file, a push) instead of touching a closed
   *  workspace. Only the request it was waiting on can still finish. */
  const alive = () => {
    if (stopped) throw new CycleStop();
  };
  const stop = (event: SyncEvent): never => {
    deps.dispatch(event);
    throw new CycleStop();
  };
  const head = async () => (await git.log({ ref: branchRef, depth: 1 }).catch(() => []))[0]?.oid ?? null;

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
      const paths = taken === "all" ? null : taken === "scan" ? await scan() : [...taken];
      if (paths?.length === 0) return;
      if (paths) await stageByHash(paths);
      const all = await stageChanges(git, paths);
      if (all.length === 0) return;
      alive();
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

  /** Files among `paths` with uncommitted edits. */
  const dirtyAmong = async (paths: string[]) => {
    if (paths.length === 0) return [];
    const status = await git.status({ filepaths: paths });
    const edited = new Set([...status.staged, ...status.unstaged].map((c) => c.path).concat(status.untracked));
    return paths.filter((path) => edited.has(path));
  };

  /** Write one file as it is at `to`; `held` when its editor keeps unsaved
   *  edits. Throws on a write the fs refused. */
  const applyFile = async (filepath: string, to: string): Promise<"written" | "deleted" | "held"> => {
    const bytes = await git.readFile({ ref: to, filepath });
    const path = absolute(filepath);
    if (bytes === null) {
      const { failed } = await deps.fs.deleteFiles([path]);
      const refused = failed.find((failure) => failure.type !== "not_found");
      if (refused) throw new Error(`Couldn't delete ${filepath}: ${refused.message}`);
      return "deleted";
    }
    const text = bytes.includes(0) ? null : decodeText(bytes);
    if (text !== null) return (await deps.documents.write(path, text, { source: "sync" })) === "held" ? "held" : "written";
    const { failed } = await deps.fs.writeBinaryFiles([{ path, data: bytes }]);
    if (failed[0]) throw new Error(`Couldn't write ${filepath}: ${failed[0].message}`);
    return "written";
  };

  /** Bring index and worktree from `from` to `to` for the files that
   *  differ; text is written through the documents write path, which holds
   *  back a file with unsaved edits. */
  const moveWorktree = async (move: Move) => {
    const { from, to, done } = move;
    const changes = { created: [] as string[], deleted: [] as string[], held: move.held };
    const remaining = (await git.changedFiles(from, to, { toApply: true })).filter((path) => !NEVER.test(path) && !done.has(path));
    // A retry: a file not written yet may have been saved here since.
    const edited = done.size > 0 ? await editedSince(remaining) : [];
    for (const filepath of remaining) {
      alive();
      if (edited.includes(filepath)) {
        if (!keepLocalOnce) continue;
        // Keep mine: the saved file stays, and its index takes the remote's
        // version, so the save commits on top of it.
        await git.unstage({ filepath, ref: to });
        done.add(filepath);
        continue;
      }
      const outcome = await applyFile(filepath, to);
      changes[outcome === "written" ? "created" : outcome].push(absolute(filepath));
      // Only once the file is on disk: a failed write leaves the index at
      // the old version, and the cycle finishes the move (`unfinished`)
      // before it commits anything. A held file's index takes the remote's
      // version: the unsaved edits then read as a change on top of it.
      await git.unstage({ filepath, ref: to });
      done.add(filepath);
    }
    if (edited.length > 0 && !keepLocalOnce) {
      stop({ type: "diverged", detail: `Changed here and on the remote: ${edited.join(", ")}. Sync stopped so neither side is lost.` });
    }
    unfinished = null;
    const { created, deleted, held } = changes;
    if (created.length > 0 || deleted.length > 0) {
      await deps.files.recordDiskChanges({ created, deleted });
      deps.hooks.emit("sync:remote-applied", { workspacePath: root, commit: to, paths: [...created, ...deleted] });
    }
    if (held.length > 0 && !keepLocalOnce) {
      // The remote's version is committed; the unsaved edits stay in the
      // editor. Without a merge (solo), that is a stop.
      stop({
        type: "diverged",
        detail: `Unsaved edits kept in ${held.map((path) => pathutil.basename(path)).join(", ")} while the remote changed them. Sync stopped so neither side is lost.`,
      });
    }
  };

  const pullStep = async () => {
    deps.dispatch({ type: "step", activity: "pulling" });
    // Also moves refs/remotes/origin/<branch>, keeping a diverged tip reachable.
    alive();
    const [fetched] = await git.fetchRefs(remote, [branchRef]);
    const theirs = fetched?.oid;
    if (!theirs) throw new GitError("RepoNotFound", "The remote branch is gone.");
    const ours = await head();
    if (!ours) throw new GitError("InvalidInput", "The branch has no commits.");
    const base = ours === theirs ? ours : await git.mergeBase(ours, theirs);
    if (!base) {
      stop({ type: "diverged", detail: "The remote branch shares no history with this workspace (it was rewritten or force-pushed)." });
    }
    if (base === theirs) {
      integrated = theirs;
      return;
    }
    // Before the branch moves: what the file API can't write stops here.
    const remoteFiles = await git.changedFiles(base!, theirs, { toApply: true });
    const edited = await dirtyAmong(remoteFiles);
    if (edited.length > 0) {
      stop({ type: "diverged", detail: `Changed here and on the remote: ${edited.join(", ")}. Sync stopped so neither side is lost.` });
    }
    if (base === ours) {
      alive();
      await git.merge({ ours: branchRef, theirs, fastForwardOnly: true });
      unfinished = { from: ours, to: theirs, done: new Set(), held: [] };
      await moveWorktree(unfinished);
      integrated = theirs;
      return;
    }
    // Replay: the local commits since `base` as one commit on `theirs`.
    const localFiles = await git.changedFiles(base!, ours);
    const local = new Set(localFiles);
    const both = remoteFiles.filter((path) => local.has(path));
    if (both.length > 0 && !keepLocalOnce) {
      stop({ type: "diverged", detail: `Changed here and on the remote: ${both.join(", ")}. Sync stopped so neither side is lost.` });
    }
    alive();
    for (const filepath of remoteFiles) {
      if (!local.has(filepath)) await git.unstage({ filepath, ref: theirs });
    }
    alive();
    const replayed = await git.commit({ message: commitMessage(author.name, localFiles), author, parent: [theirs] });
    unfinished = { from: ours, to: replayed, done: new Set(), held: [] };
    await moveWorktree(unfinished);
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
    alive();
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
      alive();
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
    const refs = await git.listRemoteRefs(remote, [branchRef]);
    const theirs = refs.find((ref) => ref.ref === branchRef)?.oid ?? null;
    const ours = await head();
    if (theirs) await checkReturn(theirs, ours);
    if (theirs && (theirs === ours || (theirs !== integrated && (await behindOurs(theirs, ours))))) integrated = theirs;
    else if (theirs && theirs !== integrated) await pullStep();
    return pushStep(theirs);
  };

  const markSynced = () => {
    returnApproved = false;
    lastSynced = now();
    // The scan after a restart starts from this, so never past unsaved work.
    if (pending() || lastSynced - lastRecorded < RECORD_SYNCED_EVERY_MS) return;
    lastRecorded = lastSynced;
    void deps.recordSynced(lastSynced).catch(() => {});
  };

  const cycle = async () => {
    if (!isRunning(deps.state())) return;
    try {
      if ((await git.currentBranch()) !== branch) {
        stopped = true;
        deps.branchChanged();
        return;
      }
      if (unfinished) await moveWorktree(unfinished);
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
      markSynced();
      deps.dispatch({ type: "settled" });
    } catch (error) {
      if (!(error instanceof CycleStop)) deps.dispatch(faultOf(error, remote.url));
    }
  };

  const schedulePoll = (ms?: number) => {
    cancelPoll?.();
    cancelPoll = null;
    if (stopped || !isRunning(deps.state())) return;
    cancelPoll = setTimer(
      () => {
        cancelPoll = null;
        void syncNow(false);
      },
      ms ?? pollInterval(deps.state()) * (0.8 + random() * 0.4),
    );
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
      // A short recheck set during the cycle stays.
      if (!cancelPoll) schedulePoll();
    });
    return running;
  };

  const written = (paths: string[]) => {
    const trees = paths.map(tree).filter((path): path is string => path !== null);
    if (trees.length === 0 || stopped) return;
    if (typeof dirty !== "string") for (const path of trees) dirty.add(path);
    cancelIdle?.();
    cancelIdle = setTimer(() => void syncNow(), IDLE_COMMIT_MS);
  };
  const pending = () => typeof dirty === "string" || dirty.size > 0;
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
    async resume() {
      if (deps.state().fault !== "paused") keepLocalOnce = true;
      returnApproved = true;
      deps.dispatch({ type: "resume" });
      try {
        await syncNow();
      } finally {
        keepLocalOnce = false;
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
      await Promise.race([last?.catch(() => {}), deadline]);
      cancelDeadline();
      stopped = true;
      cancelIdle?.();
      cancelPoll?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/** Stage what status reports among `paths` (all when null); the paths
 *  the commit will hold. `.gitignore` and the sync excludes apply. */
async function stageChanges(git: GitService, paths: string[] | null): Promise<string[]> {
  const status = await git.status(paths ? { filepaths: paths } : undefined);
  const add = [...status.untracked];
  for (const change of status.unstaged) {
    // A tracked file the excludes name (`.claude/` committed before sync)
    // stays as it is on the remote.
    if (await git.isIgnored(change.path)) continue;
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

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
