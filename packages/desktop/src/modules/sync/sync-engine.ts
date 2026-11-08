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
 *    touch other files, so the branch stays linear. A file changed on both
 *    sides is merged by units (`sync-merge.ts`), the replay carries the
 *    result, and the text a collision overwrote is flagged;
 * 4. push if ahead, compare-and-swap against the polled tip. A refused
 *    push reruns the cycle (bounded, with jitter); a push with no answer
 *    may have landed, so the next poll comes soon.
 *
 * Back after more than an hour away with local changes, or far apart from
 * the remote, it pauses before taking anything in until the user says go.
 */
import type { Hooks } from "@notefig/core";
import { GitError, type GitRemote, type GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { DocumentsApi } from "@/modules/documents";
import type { WorkspaceFiles } from "@/modules/files";
import { IGNORE_RULES } from "@/utils/ignore";
import { path as pathutil } from "@/utils/path";
import {
  IDLE_COMMIT_MS,
  pollInterval,
  isRunning,
  type SyncEvent,
  type SyncOverwrite,
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
  /** Keep the last successful sync (sync.json). */
  recordSynced(at: number): Promise<void>;
  setTimer?: (run: () => void, ms: number) => () => void;
  onBlur?: (listener: () => void) => () => void;
  now?: () => number;
  random?: () => number;
}

export interface SyncEngine {
  syncNow(): Promise<void>;
  /** Leave a stop and go on (after `paused`, without asking again). */
  resume(): Promise<void>;
  /** Commit and push what's left (briefly), then stop. */
  stop(): Promise<void>;
}

const MAX_PUSH_RETRIES = 3;
const RECOVERY_PREFIX = "refs/notefig/recovery/";
const MAX_RECOVERY_REFS = 50;
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
const MARKDOWN = /\.(md|markdown)$/i;
/** The app's folder and git's never sync. */
const NEVER = /^(\.notefig|\.git)(\/|$)/;

/** Raised to end a cycle whose stop was already dispatched. */
class CycleStop extends Error {}

/** A remote refused the push because it moved. */
const PUSH_REFUSALS = new Set(["NotFastForward", "RefConflict", "PushRejected"]);

export function faultOf(error: unknown): SyncEvent {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof GitError ? error.code : "Unknown";
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
  let lastSynced = deps.lastSyncedAt;
  let lastRecorded = lastSynced ?? 0;
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
  const stageByHash = async (paths: string[]) => {
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
      await git.commit({ message: commitMessage(author.name, all), author });
    } catch (error) {
      // Keep what wasn't committed for the next try.
      commitDue = true;
      dirty = typeof taken === "string" ? taken : new Set([...taken, ...(dirty as Set<string>)]);
      throw error;
    }
  };

  // --- Pull ---------------------------------------------------------------

  /** Files among `paths` with uncommitted edits. */
  const dirtyAmong = async (paths: string[]) => {
    if (paths.length === 0) return [];
    const status = await git.status({ filepaths: paths });
    const edited = new Set([...status.staged, ...status.unstaged].map((c) => c.path).concat(status.untracked));
    return paths.filter((path) => edited.has(path));
  };

  /** Bring index and worktree from `from` to `to` for the files that
   *  differ; the bytes are written through the documents write path, which
   *  holds back a file with unsaved edits. */
  const moveWorktree = async (from: string, to: string, written: ReadonlySet<string> = new Set()) => {
    const held: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const filepath of await git.changedFiles(from, to)) {
      if (NEVER.test(filepath) || written.has(filepath)) continue;
      const bytes = await git.readFile({ ref: to, filepath });
      await git.unstage({ filepath, ref: to });
      const path = absolute(filepath);
      if (bytes === null) {
        await deps.fs.deleteFiles([path]);
        deleted.push(path);
        continue;
      }
      const text = asText(bytes);
      if (text === null) {
        await deps.fs.writeBinaryFiles([{ path, data: bytes }]);
      } else if ((await deps.documents.write(path, text, { source: "sync" })) === "held") {
        held.push(pathutil.basename(path));
        continue;
      }
      created.push(path);
    }
    if (created.length > 0 || deleted.length > 0) {
      await deps.files.recordDiskChanges({ created, deleted });
      deps.hooks.emit("sync:remote-applied", { workspacePath: root, commit: to, paths: [...created, ...deleted] });
    }
    if (held.length > 0) {
      // The remote's version is committed; the unsaved edits stay in the
      // editor, and saving them would overwrite it: stop.
      stop({
        type: "diverged",
        detail: `Unsaved edits kept in ${held.join(", ")} while the remote changed them. Sync stopped so neither side is lost.`,
      });
    }
  };

  /** The file holds the merge's text, staged, ready for the replay. A held
   *  write stops the cycle; the path is re-staged when sync goes on. */
  const writeMerged = async (filepath: string, text: string) => {
    if (typeof dirty !== "string") dirty.add(filepath);
    if ((await deps.documents.write(absolute(filepath), text, { source: "sync" })) === "held") {
      stop({ type: "diverged", detail: `Unsaved edits in ${filepath} while the remote changed it. Sync stopped so neither side is lost.` });
    }
    await git.add({ filepath });
  };

  /** Settle a file both sides changed; true when it was written here. */
  const settleBoth = async (
    filepath: string,
    base: string,
    ours: string,
    theirs: string,
    replaced: Omit<SyncOverwrite, "ref">[],
  ): Promise<boolean> => {
    const [b, o, t] = await Promise.all([base, ours, theirs].map((ref) => git.readFile({ ref, filepath })));
    // Deleted on one side, edited on the other: keep the edit.
    if (t === null) return false;
    const mine = o && asText(o);
    const incoming = asText(t);
    if (MARKDOWN.test(filepath) && mine != null && incoming !== null) {
      const { mergeMarkdown } = await import("./sync-merge");
      const { text, overwritten } = mergeMarkdown((b && asText(b)) ?? "", mine, incoming);
      await writeMerged(filepath, text);
      for (const lost of overwritten) replaced.push({ path: filepath, text: lost });
      return true;
    }
    // Not markdown, or binary: the branch's version stands.
    await git.unstage({ filepath, ref: theirs });
    if (o) replaced.push({ path: filepath, text: mine ?? null });
    return false;
  };

  /** Keep this side whole on a ref that is never pushed, before a replay
   *  leaves it unreachable: the newest `MAX_RECOVERY_REFS` stay. */
  const saveRecovery = async (oid: string): Promise<string> => {
    const ref = `${RECOVERY_PREFIX}${now()}-${oid.slice(0, 8)}`;
    await git.writeRef(ref, oid);
    const refs = await git.listRefs(RECOVERY_PREFIX);
    for (const old of refs.slice(0, -MAX_RECOVERY_REFS)) await git.deleteRef(old);
    return ref;
  };

  const pullStep = async () => {
    deps.dispatch({ type: "step", activity: "pulling" });
    // Also moves refs/remotes/origin/<branch>, keeping a diverged tip reachable.
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
    const remoteFiles = await git.changedFiles(base!, theirs);
    const edited = await dirtyAmong(remoteFiles);
    if (edited.length > 0) {
      stop({ type: "diverged", detail: `Changed here and on the remote: ${edited.join(", ")}. Sync stopped so neither side is lost.` });
    }
    if (base === ours) {
      await git.merge({ ours: branchRef, theirs, fastForwardOnly: true });
      integrated = theirs;
      return moveWorktree(ours, theirs);
    }
    // Replay: the local commits since `base` as one commit on `theirs`.
    const localFiles = await git.changedFiles(base!, ours);
    const local = new Set(localFiles);
    const written = new Set<string>();
    const replaced: Omit<SyncOverwrite, "ref">[] = [];
    for (const filepath of remoteFiles) {
      if (!local.has(filepath)) await git.unstage({ filepath, ref: theirs });
      else if (await settleBoth(filepath, base!, ours, theirs, replaced)) written.add(filepath);
    }
    if (replaced.length > 0) {
      const ref = await saveRecovery(ours);
      deps.dispatch({ type: "overwritten", items: replaced.map((item) => ({ ...item, ref })) });
    }
    const replayed = await git.commit({ message: commitMessage(author.name, localFiles), author, parent: [theirs] });
    integrated = theirs;
    await moveWorktree(ours, replayed, written);
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

  /** Poll, pull if the remote moved, push if ahead. */
  const reconcile = async (): Promise<boolean> => {
    const refs = await git.listRemoteRefs(remote, [branchRef]);
    const theirs = refs.find((ref) => ref.ref === branchRef)?.oid ?? null;
    const ours = await head();
    if (theirs) await checkReturn(theirs, ours);
    if (theirs && theirs !== integrated && theirs !== ours) await pullStep();
    else if (theirs && theirs === ours) integrated = theirs;
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
      if (!(error instanceof CycleStop)) deps.dispatch(faultOf(error));
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
      returnApproved = true;
      deps.dispatch({ type: "resume" });
      await syncNow();
    },
    async stop() {
      cancelIdle?.();
      if (pending() && isRunning(deps.state())) {
        await Promise.race([syncNow(), new Promise<void>((done) => setTimer(done, CLOSE_SYNC_MS))]);
      }
      stopped = true;
      cancelIdle?.();
      cancelPoll?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
      await running?.catch(() => {});
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

/** A file's text; null when it is binary. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
