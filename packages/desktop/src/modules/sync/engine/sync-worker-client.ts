/**
 * Boots one sync worker and serves its host channel (fs, git HTTP) from
 * the platform. Loaded only for a sync workspace or an access check,
 * through `core.syncRuntime`.
 */
import type { GitWorkerInitMessage } from "@notefig/git";
import { createWorkerClient, serveWorkerHost } from "@notefig/worker";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { getDesktopOs } from "@/utils/platform";
import type { SyncWorkerApi, SyncWorkerConnection } from "../sync-types";
import { serializeHostError, syncHostApi } from "./sync-host";

export async function bootSyncWorker(
  platform: Pick<IPlatformAdapter, "fs" | "gitHttp">,
): Promise<SyncWorkerConnection> {
  const worker = new Worker(
    new URL("../../../workers/sync.worker.ts", import.meta.url),
    { type: "module", name: "notefig-sync" },
  );
  serveWorkerHost(worker, syncHostApi(platform), serializeHostError);
  worker.postMessage({
    gitWorkerInit: true,
    globals: { __NOTEFIG_DESKTOP_OS__: getDesktopOs() },
  } satisfies GitWorkerInitMessage);
  const { client, ready, terminate } = createWorkerClient<SyncWorkerApi>(worker);
  try {
    await ready;
  } catch (error) {
    terminate();
    throw error;
  }
  return { api: client, terminate };
}
