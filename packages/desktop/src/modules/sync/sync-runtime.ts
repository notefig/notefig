/**
 * `core.syncRuntime`: where the sync engine and its worker come from. The
 * one place either is reached, and only through dynamic `import()`, so a
 * regular workspace never loads the engine chunk or starts a worker
 * (`sync-isolation.test.ts` holds this to the static import graph).
 *
 * Tests list their own `syncRuntime` (same name) that serves the worker
 * API in-process over a fake remote; nothing else differs.
 */
import { defineModule } from "@notefig/core";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import type { SyncEngineFactory, SyncWorkerConnection } from "./sync-types";

export interface SyncRuntime {
  /** Load the engine chunk. */
  loadEngine(): Promise<SyncEngineFactory>;
  /** Start a sync worker (one per sync workspace, or one for a check). */
  launchWorker(): Promise<SyncWorkerConnection>;
}

/** The engine is loaded once; every sync workspace shares the chunk. */
export function loadSyncEngine(): Promise<SyncEngineFactory> {
  return import("./engine/sync-engine").then((engine) => engine.startSyncEngine);
}

export function createSyncRuntime(
  platform: Pick<IPlatformAdapter, "fs" | "gitHttp">,
): SyncRuntime {
  return {
    loadEngine: loadSyncEngine,
    launchWorker: async () => {
      const { bootSyncWorker } = await import("./engine/sync-worker-client");
      return bootSyncWorker(platform);
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    syncRuntime: SyncRuntime;
  }
}

export const syncRuntimeModule = defineModule({
  name: "syncRuntime",
  needs: [platformModule],
  register: (ctx) => createSyncRuntime(ctx.use("platform")),
});
