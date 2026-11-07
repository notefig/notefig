/**
 * The sync engine's main-thread side, for one sync workspace. Loaded only
 * when the workspace has a sync config (`core.syncRuntime`).
 *
 * It decides *when*; the worker does the git work, the merges included.
 * The main thread only listens to cheap hooks, keeps timers, and applies
 * what the worker returns through the documents write path. Nothing runs
 * per keystroke: edits reach it through `files:written` (once per save)
 * and the watcher's `files:changed`.
 *
 * A cycle, serialized (a request during one runs once after it):
 * 1. merge local edits left over from an earlier pull (below);
 * 2. commit the files seen written since the last cycle (a scan for what
 *    changed while closed, on start);
 * 3. poll the remote branch (one `ls-refs`);
 * 4. if the remote moved to a commit not yet taken in, pull it: fetch,
 *    then fast-forward, or replay the local commits onto it, and apply
 *    the changed files;
 * 5. push if the branch is ahead, compare-and-swap against the polled tip.
 *    Refused (someone pushed first): back to 3, with jittered back-off.
 *
 * Merging. Solo never merges: a remote that moved under our own commits
 * (a pull that has to replay them onto it) proves someone else is
 * writing, so the engine raises `contention`, the machine goes shared,
 * and the pull runs again with the markdown merge as the worker's merge
 * driver (the side already on the branch holds; MET-273 adds leases).
 * Contention clears after a quiet spell. A file whose open editor holds
 * edits not yet saved, or whose save landed after the commit, isn't
 * overwritten: it is "pending" — kept out of commits — until its local
 * text is merged onto the branch's version in the worker and written back
 * (`sync-apply.ts`).
 *
 * The failsafe (decision 20): no merge base (a rewritten branch), a merge
 * that fails validation, or edits made offline that collide with too much
 * of what changed meanwhile. The worker saves the local branch to a
 * local-only recovery ref first; then sync stops and the user chooses
 * "Accept all incoming" (`acceptIncoming`) or turning sync off.
 *
 * Anything a merge overwrote is reported (`overwritten`, the
 * `sync:overwritten` hook), with the recovery ref that keeps it.
 */
import { path as pathutil } from "@/utils/path";
import { readRepoInfo, sessionSpecOf, type SyncAuthor } from "../sync-config";
import type {
  SyncEngine,
  SyncEngineDeps,
  SyncEngineFactory,
  SyncOverwrite,
  SyncPullOutcome,
  SyncResult,
  SyncStepError,
  SyncWrite,
} from "../sync-types";
import type { SyncFailsafe } from "../sync-machine";
import {
  ApplyFailsafe,
  overwriteDocument,
  reconcileLocalEdits,
  type ApplyDeps,
} from "./sync-apply";

/** A push refused this many times in a row waits for the next poll. */
const MAX_PUSH_RETRIES = 5;
/** Back-off before re-trying a refused push: base × 2^n, jittered. */
const PUSH_RETRY_BASE_MS = 200;
/** How soon to look again after a push with no answer. */
const UNKNOWN_PUSH_RECHECK_MS = 2_000;
/** Contention (the remote moving under our commits) keeps the level
 *  shared this long after it was last seen. */
export const CONTENTION_QUIET_MS = 60_000;
/** Commit author when neither sync.json nor the repo names one. */
const FALLBACK_AUTHOR: SyncAuthor = {
  name: "Notefig",
  email: "notefig@users.noreply.notefig.com",
};

/** Raised inside a cycle to stop it; already dispatched. */
class CycleStop extends Error {}

/** The machine event for a failed step. */
export function faultOf(error: SyncStepError) {
  switch (error.code) {
    case "AuthRequired":
    case "AuthFailed":
      return { type: "failed", fault: "auth-error", detail: error.message } as const;
    case "RepoNotFound":
      return {
        type: "failed",
        fault: "auth-error",
        detail: "The repository was not found, or the token can't see it.",
      } as const;
    case "Throttled":
      return { type: "failed", fault: "throttled", detail: error.message } as const;
    default:
      return { type: "failed", fault: "offline", detail: error.message } as const;
  }
}

const defaultTimer = (run: () => void, ms: number) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

const windowBlur = (listener: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("blur", listener);
  return () => window.removeEventListener("blur", listener);
};

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine & {
  start(): void;
} {
  const root = pathutil.normalize(deps.workspacePath);
  const spec = sessionSpecOf(root, deps.config);
  const api = deps.worker.api;
  const setTimer = deps.setTimer ?? defaultTimer;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => Date.now());
  const onBlur = deps.onBlur ?? windowBlur;

  let author: SyncAuthor = deps.config.author ?? FALLBACK_AUTHOR;
  /** Tree paths written since the last commit; at start, a scan for what
   *  changed while closed (everything, right after turning sync on). */
  let dirty: Set<string> | "scan" | "all" = deps.fullScan ? "all" : "scan";
  /** When the oldest uncommitted write came in (shared: the commit waits
   *  at most `commitMaxWaitMs` after it). */
  let writtenSince: number | null = null;
  /** Files with local edits made on an older commit than the branch's
   *  (tree path → that commit): merged in, not committed over it. */
  const pending = new Map<string, string>();
  /** The local branch tip, as last reported. */
  let head: string | null = null;
  /** The remote tip already taken in (pulled or pushed). */
  let integrated: string | null = null;
  /** Local commits not yet pushed were made offline (or while closed). */
  let offlineEdits = false;
  let stopped = false;
  const cleanups: (() => void)[] = [];
  let cancelIdle: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  let cancelQuiet: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  /** The worker session is open (the branch check passed). */
  let opened = false;
  /** The user resumed from a stop: the next pull keeps local files. */
  let keepLocalOnce = false;

  const treePath = (absolute: string): string | null => {
    const relative = pathutil.relative(root, absolute);
    if (relative === undefined || relative === "") return null;
    const tree = pathutil.toTreePath(relative);
    // The app's own folder and git's never sync.
    return /^(\.notefig|\.git)(\/|$)/.test(tree) ? null : tree;
  };

  const absolute = (tree: string) =>
    pathutil.join(root, pathutil.fromTreePath(tree));

  /** Unwrap a worker answer or stop the cycle with its fault. */
  const unwrap = <T>(result: SyncResult<T>): T => {
    if (result.ok) return result.value;
    const fault = faultOf(result.error);
    if (fault.fault === "offline" && head !== integrated) offlineEdits = true;
    deps.dispatch(fault);
    throw new CycleStop(result.error.message);
  };

  const diverge = (detail: string): never => {
    deps.dispatch({ type: "diverged", detail });
    throw new CycleStop(detail);
  };

  const failsafe = (stop: SyncFailsafe & { detail: string }): never => {
    const { detail, ...state } = stop;
    deps.dispatch({ type: "failsafe", failsafe: state, detail });
    deps.hooks.emit("sync:failsafe", { workspacePath: root, ...state, detail });
    throw new CycleStop(detail);
  };

  /** Someone else's commits reached the branch under ours: shared, until
   *  it has been quiet for a while. */
  const contend = () => {
    deps.dispatch({ type: "contention", active: true });
    cancelQuiet?.();
    cancelQuiet = setTimer(() => {
      cancelQuiet = null;
      deps.dispatch({ type: "contention", active: false });
      schedulePoll();
    }, CONTENTION_QUIET_MS);
  };

  const report = (record: SyncOverwrite, recoveryRef: string | null) => {
    deps.overwritten({
      path: absolute(record.path),
      fragments: record.fragments,
      binary: record.binary === true,
      recoveryRef,
      commit: head,
    });
  };

  const applyDeps: ApplyDeps = {
    api,
    documents: deps.documents,
    fs: deps.fs,
    unwrap,
    overwritten: report,
  };

  /** What to commit: everything written, minus files still to be merged. */
  const takeDirty = () => {
    if (typeof dirty === "string") {
      const scope = dirty;
      dirty = new Set();
      return scope;
    }
    const ready = [...dirty].filter((path) => !pending.has(path));
    dirty = new Set([...dirty].filter((path) => pending.has(path)));
    return ready;
  };

  const commitStep = async () => {
    const paths = takeDirty();
    if (typeof paths !== "string" && paths.length === 0) return;
    writtenSince = null;
    deps.dispatch({ type: "step", activity: "committing" });
    const result = await api.commit({ paths, author, userName: author.name });
    if (!result.ok) {
      // Keep what wasn't committed for the next try.
      dirty =
        typeof paths === "string" ? paths : new Set([...paths, ...(dirty as Set<string>)]);
    }
    const { oid, paths: committed } = unwrap(result);
    if (!oid) return;
    head = oid;
    // Edits made while closed are offline edits.
    if (paths === "scan") offlineEdits = true;
    deps.hooks.emit("sync:committed", {
      workspacePath: root,
      commit: oid,
      paths: committed,
    });
  };

  const markDirty = (tree: string) => {
    if (typeof dirty !== "string") dirty.add(tree);
  };

  /** Merge each pending file's local edits onto the branch, in the worker. */
  const reconcileStep = async () => {
    for (const [tree, previous] of [...pending]) {
      if (stopped) return;
      deps.dispatch({ type: "step", activity: "merging" });
      const done = await reconcileLocalEdits(applyDeps, absolute(tree), tree, previous).catch(
        (error: unknown) => {
          if (error instanceof ApplyFailsafe) {
            return failsafeAfterApply(error);
          }
          throw error;
        },
      );
      if (done === "pending") continue;
      pending.delete(tree);
      markDirty(tree);
      if (done.content !== null && head) {
        deps.delivered(absolute(tree), {
          kind: "applied",
          content: done.content,
          commit: head,
          adopted: true,
          merged: true,
        });
      }
    }
  };

  const failsafeAfterApply = async (error: ApplyFailsafe): Promise<never> => {
    const { ref } = unwrap(await api.saveRecovery());
    return failsafe({
      reason: error.reason,
      recoveryRef: ref,
      paths: error.paths,
      detail: error.detail,
    });
  };

  /** Apply a pull's writes on the main thread. Returns the files held
   *  back by unsaved edits. */
  const applyWrites = async (writes: SyncWrite[], commit: string) => {
    const held: string[] = [];
    const applied: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const write of writes) {
      const path = absolute(write.path);
      if (write.kind === "text") {
        const outcome = await deps.documents.write(path, write.text, {
          source: "sync",
        });
        if (outcome !== "written") {
          held.push(write.path);
          continue;
        }
        deps.delivered(path, {
          kind: "applied",
          content: write.text,
          commit,
          adopted: true,
        });
        created.push(path);
      } else if (write.kind === "binary") {
        await deps.fs.writeBinaryFiles([{ path, data: write.bytes }]);
        created.push(path);
      } else {
        await deps.fs.deleteFiles([path]);
        deleted.push(path);
      }
      applied.push(path);
    }
    if (created.length > 0 || deleted.length > 0) {
      await deps.files.recordDiskChanges({ created, deleted });
    }
    if (applied.length > 0) {
      deps.hooks.emit("sync:remote-applied", {
        workspacePath: root,
        commit,
        paths: applied,
      });
    }
    return held;
  };

  type Moved = Extract<SyncPullOutcome, { status: "fast-forward" | "rebased" }>;

  const settleMoved = async (outcome: Moved, remote: string) => {
    head = outcome.head;
    integrated = remote;
    offlineEdits = false;
    if (outcome.status === "rebased") contend();
    for (const record of outcome.overwritten) report(record, outcome.recoveryRef);
    const held = await applyWrites(outcome.writes, outcome.head);
    for (const tree of [...held, ...outcome.skippedDirty]) {
      // The earliest base stays: the local edits are on top of it.
      if (!pending.has(tree)) pending.set(tree, outcome.previous);
    }
    if (pending.size === 0) return;
    if (!deps.capabilities().merges) {
      // Without the merge the local edits would be committed over the
      // remote's: go shared and merge them.
      contend();
    }
    await reconcileStep();
  };

  const settlePull = async (outcome: SyncPullOutcome, remote: string) => {
    switch (outcome.status) {
      case "failsafe":
        return failsafe({
          reason: outcome.reason,
          recoveryRef: outcome.recoveryRef,
          paths: outcome.paths,
          detail: outcome.detail,
        });
      case "diverged":
        return diverge(
          `Changed here and on the remote: ${outcome.paths.join(", ")}. Sync stopped so neither side is lost.`,
        );
      case "up-to-date":
        integrated = remote;
        return;
      default:
        return settleMoved(outcome, remote);
    }
  };

  const pull = async (remote: string, merge: boolean) => {
    const keepLocal = keepLocalOnce;
    keepLocalOnce = false;
    return unwrap(await api.pull({ remote, keepLocal, merge, offline: offlineEdits }));
  };

  const pullStep = async (remote: string) => {
    deps.dispatch({ type: "step", activity: "fetching" });
    let outcome = await pull(remote, deps.capabilities().merges);
    if (outcome.status === "diverged") {
      // Solo refused to merge: someone else is writing. Go shared, merge.
      contend();
      deps.dispatch({ type: "step", activity: "merging" });
      outcome = await pull(remote, true);
    }
    await settlePull(outcome, remote);
  };

  /** Check the branch and open the worker session, once it passes. */
  const ensureOpen = async () => {
    if (opened) return;
    const repo = await readRepoInfo(deps.fs, root);
    author = deps.config.author ?? repo?.author ?? FALLBACK_AUTHOR;
    if (repo?.branch !== deps.config.branch) {
      diverge(
        `This workspace has ${repo?.branch ?? "no branch"} checked out, but syncs ${deps.config.branch}. Check out ${deps.config.branch}, then resume.`,
      );
    }
    head = unwrap(await api.open(spec)).head;
    opened = true;
  };

  /** Push; true when the remote refused (it moved), so the cycle reruns. */
  const pushStep = async (remote: string | null): Promise<boolean> => {
    if (!head || head === remote) return false;
    deps.dispatch({ type: "step", activity: "pushing" });
    const outcome = unwrap(await api.push({ remote }));
    switch (outcome.status) {
      case "pushed":
        integrated = outcome.head;
        offlineEdits = false;
        deps.hooks.emit("sync:pushed", { workspacePath: root, commit: outcome.head });
        return false;
      case "up-to-date":
        return false;
      case "rejected":
        return true;
      case "unknown":
        // It may have landed: look again soon instead of guessing.
        schedulePoll(UNKNOWN_PUSH_RECHECK_MS);
        return false;
    }
  };

  /** One attempt: poll, pull if needed, push if ahead. */
  const reconcile = async (): Promise<boolean> => {
    const { remote } = unwrap(await api.poll());
    if (remote && remote !== integrated && remote !== head) {
      await pullStep(remote);
    } else if (remote && remote === head) {
      integrated = remote;
    }
    return pushStep(remote);
  };

  const backOff = (retry: number) =>
    new Promise<void>((resume) =>
      setTimer(resume, PUSH_RETRY_BASE_MS * 2 ** retry * (0.5 + random())),
    );

  const cycle = async () => {
    if (!deps.capabilities().commits) return;
    try {
      await ensureOpen();
      await reconcileStep();
      await commitStep();
      let refused = await reconcile();
      for (let retry = 0; refused && retry < MAX_PUSH_RETRIES; retry++) {
        // Someone pushed first: fetch, merge, try again.
        await backOff(retry);
        if (stopped) return;
        refused = await reconcile();
      }
      deps.dispatch({ type: "settled" });
    } catch (error) {
      if (!(error instanceof CycleStop)) {
        deps.dispatch({
          type: "failed",
          fault: "offline",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const schedulePoll = (ms?: number) => {
    cancelPoll?.();
    cancelPoll = null;
    const capabilities = deps.capabilities();
    if (stopped || !capabilities.polls) return;
    const jittered = ms ?? capabilities.pollIntervalMs * (0.8 + random() * 0.4);
    cancelPoll = setTimer(() => {
      cancelPoll = null;
      void syncNow();
    }, jittered);
  };

  /** Run a cycle; a request while one runs queues exactly one more. */
  const syncNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    cancelIdle?.();
    cancelIdle = null;
    running = (async () => {
      do {
        again = false;
        await cycle();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
      // A short recheck set during the cycle (a push with no answer) stays.
      if (!stopped && !cancelPoll) schedulePoll();
    });
    return running;
  };

  /** The commit timer: after a pause in writes; shared also caps the wait
   *  while they go on, so commits coalesce to one per few seconds. */
  const scheduleCommit = () => {
    const capabilities = deps.capabilities();
    writtenSince ??= now();
    let delay = capabilities.idleCommitMs;
    if (capabilities.commitMaxWaitMs !== null) {
      const deadline = writtenSince + capabilities.commitMaxWaitMs - now();
      delay = Math.max(0, Math.min(delay, deadline));
    }
    cancelIdle?.();
    cancelIdle = setTimer(() => void syncNow(), delay);
  };

  const markWritten = (paths: string[]) => {
    let any = false;
    for (const path of paths) {
      const tree = treePath(path);
      if (!tree) continue;
      markDirty(tree);
      any = true;
    }
    if (!any || stopped) return;
    scheduleCommit();
  };

  const hasPendingWrites = () => typeof dirty === "string" || dirty.size > 0;

  /** The failsafe's "Accept all incoming": set the local state aside on a
   *  recovery ref, then make the branch and the files the remote's. */
  const acceptIncoming = async () => {
    await running?.catch(() => {});
    await ensureOpen();
    const local = takeDirty();
    const scope = typeof local === "string" ? local : [...local, ...pending.keys()];
    unwrap(await api.commit({ paths: scope, author, userName: author.name }));
    unwrap(await api.saveRecovery());
    const { remote } = unwrap(await api.poll());
    if (!remote) throw new Error("The remote branch is gone.");
    const reset = unwrap(await api.resetToRemote({ remote }));
    const texts = reset.writes.filter((write) => write.kind === "text");
    for (const write of texts) {
      await overwriteDocument(applyDeps, absolute(write.path), write.text);
    }
    await applyWrites(
      reset.writes.filter((write) => write.kind !== "text"),
      reset.head,
    );
    pending.clear();
    dirty = new Set();
    head = reset.head;
    integrated = reset.head;
    offlineEdits = false;
    deps.dispatch({ type: "recovered" });
    deps.hooks.emit("sync:remote-applied", {
      workspacePath: root,
      commit: reset.head,
      paths: reset.writes.map((write) => absolute(write.path)),
    });
  };

  return {
    start() {
      cleanups.push(
        deps.hooks.on("files:written", ({ paths, source }) => {
          if (source !== "sync") markWritten(paths);
        }),
        deps.hooks.on("files:changed", ({ workspacePath, paths }) => {
          if (pathutil.normalize(workspacePath) === root) markWritten(paths);
        }),
        onBlur(() => {
          if (hasPendingWrites()) void syncNow();
        }),
      );
      void syncNow();
    },
    async resume() {
      // Only the cycle the user asked for keeps local files; a later
      // divergence stops again.
      keepLocalOnce = true;
      try {
        await syncNow();
      } finally {
        keepLocalOnce = false;
      }
    },
    async acceptIncoming() {
      try {
        await acceptIncoming();
      } catch (error) {
        if (!(error instanceof CycleStop)) throw error;
        return;
      }
      await syncNow();
    },
    levelChanged() {
      if (!running) schedulePoll();
    },
    syncNow,
    async stop() {
      stopped = true;
      cancelIdle?.();
      cancelPoll?.();
      cancelQuiet?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
      await running?.catch(() => {});
      deps.worker.terminate();
    },
  };
}

export const startSyncEngine: SyncEngineFactory = async (deps) => {
  const engine = createSyncEngine(deps);
  engine.start();
  return engine;
};
