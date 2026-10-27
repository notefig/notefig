/**
 * The speech engine as the dictation service sees it, backed by
 * workers/dictation.worker.ts. The worker starts on the first dictation and
 * then keeps the model loaded; one that dies is replaced on the next call.
 */
import type { DictationWorkerRpc } from "@/workers/dictation.worker";
import { createWorkerClient, WorkerRpcError, type WorkerClient } from "@/workers/worker-rpc";

export interface DictationEngine {
  /** Loads the bundled model; cheap once loaded. */
  load(): Promise<void>;
  transcribe(samples: Float32Array): Promise<string>;
}

/** Where Vite serves `public/dictation/` from, relative to the app's base. */
const MODEL_PATH = "dictation/";

function bootWorker(): Promise<WorkerClient<DictationWorkerRpc>> {
  const worker = new Worker(new URL("../../workers/dictation.worker.ts", import.meta.url), {
    type: "module",
  });
  const { client, ready } = createWorkerClient<DictationWorkerRpc>(worker);
  return ready.then(
    () => client,
    (error) => {
      worker.terminate();
      throw error;
    },
  );
}

export function createWorkerEngine(baseUrl: string): DictationEngine {
  const modelUrl = new URL(MODEL_PATH, baseUrl).href;
  let booting: Promise<WorkerClient<DictationWorkerRpc>> | null = null;

  const client = () => {
    if (!booting) {
      const boot = bootWorker().then(async (c) => {
        await c.load(modelUrl);
        return c;
      });
      booting = boot;
      // A failed boot or load doesn't pin the rejection: the next call retries.
      boot.catch(() => {
        if (booting === boot) booting = null;
      });
    }
    return booting;
  };

  return {
    async load() {
      await client();
    },
    async transcribe(samples) {
      const c = await client();
      try {
        return (await c.transcribe(samples)).text;
      } catch (error) {
        if (error instanceof WorkerRpcError && error.workerDead) booting = null;
        throw error;
      }
    },
  };
}
