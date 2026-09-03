/**
 * Main-thread access to the git worker: one lazily-booted worker for all
 * repos, serving `@notefig/git`'s worker API. The CPU-heavy side
 * (statusMatrix's worktree hashing, packfile parsing, index rewrites) runs
 * in the worker; its filesystem access is served back to this thread over
 * worker-rpc's host channel, since Tauri `invoke` and the browser adapters
 * only exist here.
 *
 * Deliberately no inline fallback (the in-process `IsomorphicGitService`
 * stays available in `@notefig/git` for the package's own tests): a second
 * full execution path would double the surface to reason about for a
 * failure mode — worker boot failing in a real webview — we have no
 * evidence of. If the worker can't boot or dies, calls reject, which the
 * git entity already renders as errors-as-data on the repo row; the next
 * call re-attempts the boot, so a transient failure self-heals.
 * Unit tests mock this module (happy-dom has no `Worker`).
 */
import {
  createRpcGitService,
  type GitBoundaryCall,
  type GitBoundaryError,
  type GitRepoRef,
  type GitService,
  type GitWorkerApi,
  type GitWorkerInitMessage,
} from "@notefig/git";
import { platformAdapter } from "@/adapters";
import { type GitHostFs } from "@/adapters/git-storage-host";
import {
  FsError,
  type FileSystemErrorType,
} from "@/adapters/platform-adapter.interface";
import { getDesktopOs } from "@/utils/platform";
import {
  WorkerRpcError,
  createWorkerClient,
  serveWorkerHost,
  type WorkerClient,
} from "@/workers/worker-rpc";

/** Mapped alias: interfaces don't satisfy `WorkerApi`'s index constraint. */
type GitWorkerRpc = { [K in keyof GitWorkerApi]: GitWorkerApi[K] };

/** The fs slice the worker may call back into, bound late to the adapter. */
function hostFsApi(): GitHostFs {
  const fs = platformAdapter.fs;
  return {
    readBinaryFiles: (paths) => fs.readBinaryFiles(paths),
    writeBinaryFiles: (files) => fs.writeBinaryFiles(files),
    moveFile: (oldPath, newPath) => fs.moveFile(oldPath, newPath),
    deleteFiles: (paths) => fs.deleteFiles(paths),
    exists: (paths) => fs.exists(paths),
    getMetadata: (paths) => fs.getMetadata(paths),
    readDirectory: (path, options) => fs.readDirectory(path, options),
    createDirectories: (paths) => fs.createDirectories(paths),
    deleteDirectories: (paths, options) => fs.deleteDirectories(paths, options),
  };
}

/** FsError crosses the host channel with its discriminant intact. */
function serializeHostError(error: unknown): unknown {
  if (error instanceof FsError) {
    return {
      fsError: { type: error.type, path: error.path, message: error.message },
    };
  }
  return error instanceof Error ? error.message : String(error);
}

/** …and comes back out of the git boundary as an FsError again. */
function reviveBoundaryFsError(error: GitBoundaryError): Error | undefined {
  if (error.kind !== "fs") return undefined;
  return new FsError(
    error.type as FileSystemErrorType,
    error.path ?? "",
    error.message,
  );
}

let gitWorkerPromise: Promise<WorkerClient<GitWorkerRpc>> | null = null;

function bootGitWorker(): Promise<WorkerClient<GitWorkerRpc>> {
  const worker = new Worker(
    new URL("../workers/git.worker.ts", import.meta.url),
    { type: "module" },
  );
  serveWorkerHost(worker, hostFsApi(), serializeHostError);
  // The one desktop-specific global the worker's import graph needs pinned
  // before it loads: utils/path binds its posix/win32 flavor from this.
  worker.postMessage({
    gitWorkerInit: true,
    globals: { __NOTEFIG_DESKTOP_OS__: getDesktopOs() },
  } satisfies GitWorkerInitMessage);
  const { client, ready } = createWorkerClient<GitWorkerRpc>(worker);
  return ready.then(
    () => client,
    (error) => {
      worker.terminate();
      throw error;
    },
  );
}

function getGitWorker(): Promise<WorkerClient<GitWorkerRpc>> {
  if (!gitWorkerPromise) {
    const boot = (async () => bootGitWorker())();
    gitWorkerPromise = boot;
    // A failed boot doesn't pin the rejection: the next call retries.
    boot.catch(() => {
      if (gitWorkerPromise === boot) gitWorkerPromise = null;
    });
  }
  return gitWorkerPromise;
}

/** gitDirs handed out, so clear-all can reach into the worker's registry. */
const knownGitDirs = new Set<string>();

/** A `GitService` for one repo whose work runs in the git worker. */
export function createWorkerGitService(repo: GitRepoRef): GitService {
  knownGitDirs.add(repo.gitDir);
  const call: GitBoundaryCall = async (method, args) => {
    const client = await getGitWorker();
    try {
      return await client.gitCall(repo, method, args);
    } catch (error) {
      if (error instanceof WorkerRpcError && error.workerDead) {
        // Drop the dead handle so the next call boots a fresh worker; this
        // call still fails (its in-worker state is gone mid-operation).
        console.error("[git-worker] Worker died mid-call:", error.message);
        gitWorkerPromise = null;
      }
      throw error;
    }
  };
  return createRpcGitService(call, reviveBoundaryFsError);
}

/** Drop one repo's service (and object cache) in the worker. */
export function disposeWorkerGitRepo(gitDir: string): void {
  knownGitDirs.delete(gitDir);
  // Never boots the worker just to dispose — only reaches into a live one.
  void gitWorkerPromise
    ?.then((client) => client.disposeRepo(gitDir))
    .catch(() => {});
}

export function clearWorkerGitRepos(): void {
  for (const gitDir of [...knownGitDirs]) {
    disposeWorkerGitRepo(gitDir);
  }
}
