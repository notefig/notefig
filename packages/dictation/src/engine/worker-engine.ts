/**
 * The speech engine the dictation service is handed, backed by
 * dictation.worker.ts over `@notefig/worker`. The worker starts on the
 * first call and then keeps the model loaded; one that dies (a crash, or
 * memory pressure) fails what it was doing and is replaced on the next call.
 */
import { createWorkerClient, WorkerRpcError, type WorkerClient } from "@notefig/worker";
import type { DictationEngine } from "../dictation";

/** What the worker serves. Declared here rather than taken off the worker,
 *  so typechecking this side never pulls in the worker and onnxruntime. */
export type DictationWorkerApi = {
  /** Loads the model from `modelUrl` once; later calls are no-ops. */
  load(modelUrl: string): Promise<void>;
  transcribe(samples: Float32Array): Promise<string>;
};

/** A worker with the model loaded; on any failure, it is stopped. */
async function startWorker(modelUrl: string): Promise<WorkerClient<DictationWorkerApi>> {
  const worker = new Worker(new URL("./dictation.worker.ts", import.meta.url), { type: "module" });
  const { client, ready, terminate } = createWorkerClient<DictationWorkerApi>(worker);
  try {
    await ready;
    await client.load(modelUrl);
    return client;
  } catch (error) {
    terminate();
    throw error;
  }
}

/** The engine over the model served at `modelUrl` (its `manifest.json`'s folder). */
export function createWorkerEngine(modelUrl: string): DictationEngine {
  let started: Promise<WorkerClient<DictationWorkerApi>> | null = null;

  const worker = () => {
    if (!started) {
      const starting = startWorker(modelUrl);
      started = starting;
      // A failed start doesn't pin the rejection: the next call retries.
      starting.catch(() => {
        if (started === starting) started = null;
      });
    }
    return started;
  };

  return {
    async load() {
      await worker();
    },
    async transcribe(samples) {
      const current = worker();
      const client = await current;
      try {
        return await client.transcribe(samples);
      } catch (error) {
        if (error instanceof WorkerRpcError && error.workerDead && started === current) started = null;
        throw error;
      }
    },
  };
}
