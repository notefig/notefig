/**
 * Sync worker entry: `@notefig/git`'s worker runtime serving the sync
 * steps (`modules/sync/engine/sync-worker-api.ts`). All git work of a sync
 * cycle runs here — status, commits, packs, fetches, pushes, rebases.
 *
 * What only the main thread has is served back over @notefig/worker's host
 * channel: the filesystem (Tauri `invoke` and the browser adapters exist
 * only there) and the git HTTP transport (Rust adds the token; it never
 * reaches this worker). The wiring loads inside the async thunk, after the
 * runtime pins the init message's globals: `utils/path` (in its import
 * graph) binds its posix/win32 flavor at evaluation from the
 * `__NOTEFIG_DESKTOP_OS__` override. Type-only imports are erased.
 */
import { startGitWorker, type GitHttpClient } from "@notefig/git";
import type { WorkerApi } from "@notefig/worker";
import type { SyncHostApi } from "@/modules/sync/engine/sync-host";

startGitWorker(async () => {
  const [
    { createGitStorageHost },
    { createHostClient, exposeWorkerApi },
    { createSyncWorkerApi, syncWorkerWiring },
    { reviveHostError },
  ] = await Promise.all([
    import("@/adapters/git-storage-host"),
    import("@notefig/worker"),
    import("@/modules/sync/engine/sync-worker-api"),
    import("@/modules/sync/engine/sync-host"),
  ]);

  const host = createHostClient<SyncHostApi>(reviveHostError);
  const http: GitHttpClient = { request: (request) => host.gitHttp(request) };
  const wiring = syncWorkerWiring(http);

  return {
    createHost: (repo) => wiring.wrapHost(createGitStorageHost(host), repo),
    createDeps: wiring.deps,
    expose: (git) =>
      exposeWorkerApi(
        createSyncWorkerApi(git, wiring.capture, http) as unknown as WorkerApi,
      ),
  };
});
