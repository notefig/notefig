/**
 * The speech engine the dictation service is handed, backed by
 * dictation.worker.ts. The worker starts on the first call and then keeps
 * the model loaded; one that dies (a crash, or memory pressure) fails what
 * it was doing and is replaced on the next call.
 */
import type { DictationEngine } from "../dictation";
import type { WorkerCall, WorkerRequest, WorkerResponse } from "./protocol";

/** One worker: calls in, answers out, and every call failed if it dies. */
function startWorker(onDeath: () => void) {
  const worker = new Worker(new URL("./dictation.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  worker.onmessage = ({ data: response }: MessageEvent<WorkerResponse>) => {
    const call = pending.get(response.id);
    pending.delete(response.id);
    if (response.ok) call?.resolve(response.text ?? "");
    else call?.reject(new Error(response.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    worker.terminate();
    onDeath();
    const error = new Error(`Dictation worker stopped: ${event.message || "it failed to start"}`);
    pending.forEach((call) => call.reject(error));
    pending.clear();
  };
  const call = (request: WorkerCall) =>
    new Promise<string>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...request } satisfies WorkerRequest);
    });
  return { call, stop: () => worker.terminate() };
}

type Started = ReturnType<typeof startWorker>["call"];

/** The engine over the model served at `modelUrl` (its `manifest.json`'s folder). */
export function createWorkerEngine(modelUrl: string): DictationEngine {
  let ready: Promise<Started> | null = null;

  const worker = () => {
    if (!ready) {
      const { call, stop } = startWorker(() => {
        if (ready === starting) ready = null;
      });
      const starting = call({ method: "load", modelUrl }).then(() => call);
      ready = starting;
      // A failed load doesn't pin the rejection: the next call retries, on
      // a fresh worker.
      starting.catch(() => {
        stop();
        if (ready === starting) ready = null;
      });
    }
    return ready;
  };

  return {
    async load() {
      await worker();
    },
    async transcribe(samples) {
      const call = await worker();
      return call({ method: "transcribe", samples });
    },
  };
}
