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

import { Cause, Deferred, Duration, Effect, Exit, Fiber } from "effect";

export type WorkerApi = Record<string, (...args: any[]) => any>;

/**
 * Boundary unwrap: `Effect.runPromise` rejects with a `FiberFailure` wrapper,
 * but callers here catch the raw `WorkerRpcError` (e.g. `error.workerDead`).
 * `runPromiseExit` + `Cause.squash` hands back the original error unchanged.
 */
const toPromise = <A>(effect: Effect.Effect<A, WorkerRpcError>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) =>
    Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)),
  );

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
  // Each pending call and the ready handshake are `Deferred`s: they complete
  // exactly once, so `failAll` racing a late response can never double-settle,
  // and there is no `readyResolve!`/`readyReject!` escape-hatch pair.
  const pending = new Map<number, Deferred.Deferred<unknown, WorkerRpcError>>();
  const ready = Effect.runSync(Deferred.make<void, WorkerRpcError>());

  // Ready budget as a forked timer; interrupted below when the handshake lands
  // (the structured-concurrency equivalent of clearTimeout).
  const readyTimer = Effect.runFork(
    Effect.sleep(Duration.millis(readyTimeoutMs)).pipe(
      Effect.zipRight(
        Effect.sync(() =>
          Deferred.unsafeDone(
            ready,
            Effect.fail(
              new WorkerRpcError(
                `Worker did not become ready within ${readyTimeoutMs}ms`,
                true,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const failAll = (message: string) => {
    dead = true;
    Effect.runFork(Fiber.interrupt(readyTimer));
    const error = () => Effect.fail(new WorkerRpcError(message, true));
    Deferred.unsafeDone(ready, error());
    for (const deferred of pending.values()) Deferred.unsafeDone(deferred, error());
    pending.clear();
  };

  worker.onmessage = (event: MessageEvent) => {
    if (event.data === READY_MESSAGE) {
      Effect.runFork(Fiber.interrupt(readyTimer));
      Deferred.unsafeDone(ready, Effect.void);
      return;
    }
    const response = event.data as RpcResponse;
    if (!response || response.rpc !== true) return;
    const deferred = pending.get(response.id);
    if (!deferred) return;
    pending.delete(response.id);
    Deferred.unsafeDone(
      deferred,
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(new WorkerRpcError(response.error ?? "RPC failed", false)),
    );
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
      return (...args: unknown[]) => {
        if (dead) {
          return Promise.reject(new WorkerRpcError("Worker is dead", true));
        }
        const id = nextId++;
        const deferred = Effect.runSync(Deferred.make<unknown, WorkerRpcError>());
        pending.set(id, deferred);
        worker.postMessage({ rpc: true, id, method, args } as RpcRequest);
        return toPromise(Deferred.await(deferred));
      };
    },
  });

  const readyPromise = toPromise(Deferred.await(ready));
  // A caller may only consume `ready` via Promise.race or not at all.
  readyPromise.catch(() => {});

  return {
    client,
    ready: readyPromise,
    terminate: () => {
      failAll("Worker terminated");
      worker.terminate();
    },
  };
}
