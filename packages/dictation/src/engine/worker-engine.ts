/**
 * The speech engine the dictation service is handed, backed by
 * dictation.worker.ts over `@notefig/worker`. The worker starts on the
 * first call and then keeps the model loaded; one that dies (a crash, or
 * memory pressure) fails what it was doing and is replaced on the next call.
 */
import { createWorkerClient, type WorkerClient } from "@notefig/worker";
import type { DictationEngine } from "../dictation";

/** What the worker serves. Declared here rather than taken off the worker,
 *  so typechecking this side never pulls in the worker and onnxruntime. */
export type DictationWorkerApi = {
  /** Loads the model from `modelUrl` once; later calls are no-ops. */
  load(modelUrl: string): Promise<void>;
  transcribe(samples: Float32Array): Promise<string>;
};

/** A worker with the model loaded; on any failure, it is stopped. `onDead`
 *  hears of its death whenever it comes, even between calls. */
async function startWorker(
  modelUrl: string,
  onDead: () => void,
): Promise<WorkerClient<DictationWorkerApi>> {
  const worker = new Worker(new URL("./dictation.worker.ts", import.meta.url), { type: "module" });
  const { client, ready, terminate } = createWorkerClient<DictationWorkerApi>(worker, { onDead });
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
      // A worker that dies, or fails to start, is forgotten at once: the
      // next call (the next dictation's warm-up, say) starts a fresh one.
      const forget = () => {
        if (started === starting) started = null;
      };
      const starting = startWorker(modelUrl, forget);
      started = starting;
      starting.catch(forget);
    }
    return started;
  };

  return {
    async load() {
      await worker();
    },
    async transcribe(samples) {
      const client = await worker();
      return client.transcribe(samples);
    },
  };
}
