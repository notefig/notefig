/**
 * The sync engine's main-thread side, for one sync workspace. Loaded only
 * when the workspace has a sync config (`core.syncRuntime`).
 *
 * It decides *when*; the worker does the git work. The main thread only
 * listens to cheap hooks, keeps timers, and applies what a pull returns
 * through the documents write path. Nothing runs per keystroke: edits
 * reach it through `files:written` (once per save) and the watcher's
 * `files:changed`.
 *
 * A cycle, serialized (a request during one runs once after it):
 * 1. commit the files seen written since the last cycle (the whole
 *    worktree on start, to catch edits made while closed);
 * 2. poll the remote branch (one `ls-refs`);
 * 3. if the remote moved to a commit not yet taken in, pull it: fetch,
 *    fast-forward (or replay local commits that touch other files), and
 *    apply the changed files;
 * 4. push if the branch is ahead, compare-and-swap against the polled tip.
 *
 * A refused push means the remote moved: the cycle runs again (bounded,
 * with jitter). A push with no answer may have landed: the next poll, soon,
 * tells. In solo, local and remote changes to the same file stop sync at
 * `diverged` rather than merge (MET-271 brings the merge).
 */
import { path as pathutil } from "@/utils/path";
import { readRepoInfo, sessionSpecOf, type SyncAuthor } from "../sync-config";
import type {
  SyncEngine,
  SyncEngineDeps,
  SyncEngineFactory,
  SyncPullOutcome,
  SyncResult,
  SyncStepError,
  SyncWrite,
} from "../sync-types";

/** A push refused this many times in a row waits for the next poll. */
const MAX_PUSH_RETRIES = 3;
/** How soon to look again after a push with no answer. */
const UNKNOWN_PUSH_RECHECK_MS = 2_000;
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
  start(): Promise<void>;
} {
  const root = pathutil.normalize(deps.workspacePath);
  const spec = sessionSpecOf(root, deps.config);
  const api = deps.worker.api;
  const setTimer = deps.setTimer ?? defaultTimer;
  const random = deps.random ?? Math.random;
  const onBlur = deps.onBlur ?? windowBlur;

  let author: SyncAuthor = deps.config.author ?? FALLBACK_AUTHOR;
  /** Tree paths written since the last commit; "all" re-walks everything. */
  let dirty: Set<string> | "all" = "all";
  /** The local branch tip, as last reported. */
  let head: string | null = null;
  /** The remote tip already taken in (pulled or pushed). */
  let integrated: string | null = null;
  let stopped = false;
  const cleanups: (() => void)[] = [];
  let cancelIdle: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let again = false;

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
    deps.dispatch(faultOf(result.error));
    throw new CycleStop(result.error.message);
  };

  const diverge = (detail: string): never => {
    deps.dispatch({ type: "diverged", detail });
    throw new CycleStop(detail);
  };

  const commitStep = async () => {
    if (dirty !== "all" && dirty.size === 0) return;
    const paths = dirty === "all" ? null : [...dirty];
    dirty = new Set();
    deps.dispatch({ type: "step", activity: "committing" });
    const result = await api.commit({ paths, author, userName: author.name });
    if (!result.ok) {
      // Keep what wasn't committed for the next try.
      dirty = paths === null ? "all" : new Set([...paths, ...(dirty as Set<string>)]);
    }
    const { oid, paths: committed } = unwrap(result);
    if (!oid) return;
    head = oid;
    deps.hooks.emit("sync:committed", {
      workspacePath: root,
      commit: oid,
      paths: committed,
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
        if (outcome === "held") {
          held.push(path);
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

  const settlePull = async (outcome: SyncPullOutcome, remote: string) => {
    if (outcome.status === "unrelated") {
      diverge(
        "The remote branch shares no history with this workspace (it was rewritten or force-pushed).",
      );
    }
    if (outcome.status === "diverged") {
      diverge(
        `Changed here and on the remote: ${outcome.paths.join(", ")}. Sync stopped so neither side is lost.`,
      );
    }
    if (outcome.status === "up-to-date") {
      integrated = remote;
      return;
    }
    if (outcome.status !== "fast-forward" && outcome.status !== "rebased") return;
    head = outcome.head;
    integrated = remote;
    const held = await applyWrites(outcome.writes, outcome.head);
    const kept = [...held, ...outcome.skippedDirty.map(absolute)];
    if (kept.length > 0) {
      // The remote's version is committed; the local edits stay in the
      // files and editors. Without a merge (solo) that is a stop.
      diverge(
        `Unsaved edits kept in ${kept.map((p) => pathutil.basename(p)).join(", ")} while the remote changed them. Sync stopped so neither side is lost.`,
      );
    }
  };

  const pullStep = async (remote: string) => {
    deps.dispatch({ type: "step", activity: "fetching" });
    const outcome = unwrap(await api.pull({ remote }));
    await settlePull(outcome, remote);
  };

  /** Push; true when the remote refused (it moved), so the cycle reruns. */
  const pushStep = async (remote: string | null): Promise<boolean> => {
    if (!head || head === remote) return false;
    deps.dispatch({ type: "step", activity: "pushing" });
    const outcome = unwrap(await api.push({ remote }));
    switch (outcome.status) {
      case "pushed":
        integrated = outcome.head;
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

  const cycle = async () => {
    if (!deps.capabilities().commits) return;
    try {
      await commitStep();
      let refused = await reconcile();
      for (let retry = 0; refused && retry < MAX_PUSH_RETRIES; retry++) {
        await new Promise<void>((resume) =>
          setTimer(resume, 200 + random() * 800),
        );
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

  const markWritten = (paths: string[]) => {
    let any = false;
    for (const path of paths) {
      const tree = treePath(path);
      if (!tree) continue;
      if (dirty !== "all") dirty.add(tree);
      any = true;
    }
    if (!any || stopped) return;
    cancelIdle?.();
    cancelIdle = setTimer(() => void syncNow(), deps.capabilities().idleCommitMs);
  };

  const hasPendingWrites = () => dirty === "all" || dirty.size > 0;

  return {
    async start() {
      const repo = await readRepoInfo(deps.fs, root);
      author = deps.config.author ?? repo?.author ?? FALLBACK_AUTHOR;
      if (repo?.branch !== deps.config.branch) {
        deps.dispatch({
          type: "diverged",
          detail: `This workspace has ${repo?.branch ?? "no branch"} checked out, but syncs ${deps.config.branch}.`,
        });
        return;
      }
      const opened = await api.open(spec);
      if (!opened.ok) {
        deps.dispatch(faultOf(opened.error));
        schedulePoll();
        return;
      }
      head = opened.value.head;
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
    syncNow,
    async stop() {
      stopped = true;
      cancelIdle?.();
      cancelPoll?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
      await running?.catch(() => {});
      deps.worker.terminate();
    },
  };
}

export const startSyncEngine: SyncEngineFactory = async (deps) => {
  const engine = createSyncEngine(deps);
  await engine.start();
  return engine;
};
