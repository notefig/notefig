/**
 * Git worker entry: `@notefig/git`'s worker runtime plus the pieces only
 * this app can supply — the fs storage host (proxied to the main thread
 * over worker-rpc's host channel, since Tauri `invoke` and the browser
 * adapters only exist there), the `FsError` revive for host failures, and
 * the RPC transport. The wiring modules load inside the async thunk, after
 * the runtime pins the init message's globals: `utils/path` (in their
 * import graph) binds its posix/win32 flavor at module evaluation from the
 * `__NOTEFIG_DESKTOP_OS__` override the main thread sends. Type-only
 * imports are erased and safe to keep static.
 */
import { startGitWorker } from "@notefig/git";
import type { FileSystemErrorType } from "@/adapters/platform-adapter.interface";
import type { GitHostFs } from "@/adapters/git-storage-host";
import type { WorkerApi } from "./worker-rpc";

/** Wire form of a main-thread FsError; see git-worker-client's serializer. */
interface SerializedHostFsError {
  fsError: { type: FileSystemErrorType; path: string; message?: string };
}

function isSerializedFsError(error: unknown): error is SerializedHostFsError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as SerializedHostFsError).fsError?.type === "string"
  );
}

startGitWorker(async () => {
  const [
    { createGitStorageHost },
    { FsError },
    { createHostClient, exposeWorkerApi },
  ] = await Promise.all([
    import("@/adapters/git-storage-host"),
    import("@/adapters/platform-adapter.interface"),
    import("./worker-rpc"),
  ]);

  const hostFs = createHostClient<GitHostFs>((error) => {
    if (isSerializedFsError(error)) {
      const { type, path, message } = error.fsError;
      return new FsError(type, path, message);
    }
    return new Error(typeof error === "string" ? error : "Host fs call failed");
  });

  return {
    createHost: (repo) => createGitStorageHost(hostFs, repo.gitDir),
    expose: (api) => exposeWorkerApi(api as unknown as WorkerApi),
  };
});
