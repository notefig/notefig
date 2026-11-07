/**
 * Boots the sync worker. Loaded only for a sync workspace (or a check),
 * through `core.syncRuntime`.
 */
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import type { SyncWorkerConnection } from "../sync-types";

export async function bootSyncWorker(
  _platform: Pick<IPlatformAdapter, "fs" | "gitHttp">,
): Promise<SyncWorkerConnection> {
  throw new Error("The sync worker is not built yet.");
}
