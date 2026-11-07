/**
 * The sync engine's main-thread side. Loaded only for a sync workspace,
 * through `core.syncRuntime`.
 */
import type { SyncEngineFactory } from "../sync-types";

export const startSyncEngine: SyncEngineFactory = async () => {
  throw new Error("The sync engine is not built yet.");
};
