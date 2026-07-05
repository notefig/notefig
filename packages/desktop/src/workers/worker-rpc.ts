/**
 * Minimal promise-based RPC over a Web Worker.
 *
 * The worker side exposes a plain object of functions; the client side gets
 * a typed proxy where every method returns a Promise. Same call-site DX as
 * function-stringifying helpers (dutyfree's createWorker, comlink), but the
 * worker is a real Vite module worker — required here because the markdown
 * codec needs its full import graph (tiptap, markdown-it, linkedom), which
 * cannot survive Function.toString() into a blob URL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WorkerApi = Record<string, (...args: any[]) => any>;

export type WorkerClient<T extends WorkerApi> = {
  [K in keyof T]: (
    ...args: Parameters<T[K]>
  ) => Promise<Awaited<ReturnType<T[K]>>>;
};

interface RpcRequest {
  rpc: true;
  id: number;
  method: string;
  args: unknown[];
}

interface RpcResponse {
  rpc: true;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const READY_MESSAGE = "__worker_rpc_ready__";

/** Thrown when the worker crashes or fails to boot; callers can fall back. */
export class WorkerRpcError extends Error {
  constructor(
    message: string,
    readonly workerDead: boolean,
  ) {
    super(message);
    this.name = "WorkerRpcError";
  }
}

/** Worker side: serve every message as an API method call. */
export function exposeWorkerApi(api: WorkerApi): void {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
  };

  scope.onmessage = async (event: MessageEvent) => {
    const request = event.data as RpcRequest;
    if (!request || request.rpc !== true) return;

    const response: RpcResponse = { rpc: true, id: request.id, ok: true };
    try {
      const method = api[request.method];
      if (typeof method !== "function") {
        throw new Error(`Unknown RPC method: ${request.method}`);
      }
      response.result = await method(...request.args);
    } catch (error) {
      response.ok = false;
      response.error = error instanceof Error ? error.message : String(error);
    }
    scope.postMessage(response);
  };

  scope.postMessage(READY_MESSAGE);
}

export interface WorkerClientHandle<T extends WorkerApi> {
  client: WorkerClient<T>;
  /** Resolves after the worker's ready handshake; rejects on boot failure. */
  ready: Promise<void>;
  terminate(): void;
}

export function createWorkerClient<T extends WorkerApi>(
  worker: Worker,
  { readyTimeoutMs = 8000 }: { readyTimeoutMs?: number } = {},
): WorkerClientHandle<T> {
  let nextId = 1;
  let dead = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    readyReject(
      new WorkerRpcError(
        `Worker did not become ready within ${readyTimeoutMs}ms`,
        true,
      ),
    );
  }, readyTimeoutMs);
  // A caller may only consume `ready` via Promise.race or not at all.
  ready.catch(() => {});

  const failAll = (message: string) => {
    dead = true;
    clearTimeout(readyTimer);
    readyReject(new WorkerRpcError(message, true));
    pending.forEach(({ reject }) =>
      reject(new WorkerRpcError(message, true)),
    );
    pending.clear();
  };

  worker.onmessage = (event: MessageEvent) => {
    if (event.data === READY_MESSAGE) {
      clearTimeout(readyTimer);
      readyResolve();
      return;
    }
    const response = event.data as RpcResponse;
    if (!response || response.rpc !== true) return;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new WorkerRpcError(response.error ?? "RPC failed", false));
    }
  };

  worker.onerror = (event) => {
    failAll(`Worker crashed: ${event.message ?? "unknown error"}`);
  };

  const client = new Proxy({} as WorkerClient<T>, {
    get(_target, method) {
      // The client is often the resolution value of a promise; `await`
      // probes it for `then`. Returning an RPC function for that (or any
      // symbol) would post the runtime's resolve/reject callbacks to the
      // worker — functions are not structured-cloneable.
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (dead) {
            reject(new WorkerRpcError("Worker is dead", true));
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ rpc: true, id, method, args } as RpcRequest);
        });
    },
  });

  return {
    client,
    ready,
    terminate: () => {
      failAll("Worker terminated");
      worker.terminate();
    },
  };
}
