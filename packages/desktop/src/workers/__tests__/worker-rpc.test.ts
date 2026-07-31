import { describe, expect, it } from "vitest";
import {
  createWorkerClient,
  exposeWorkerApi,
  WorkerRpcError,
  type WorkerApi,
} from "../worker-rpc";

/**
 * Behavioral net for worker-rpc (MET-72 spike). The module had no direct
 * coverage; these lock its observable contract — ready handshake, request/
 * response correlation, per-call errors, ready timeout, crash `failAll`, and
 * the `then`-probe guard — so the Deferred rewrite can be proven at parity.
 */

interface Scope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

interface FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage: (message: unknown) => void;
  terminate: () => void;
  terminated: boolean;
}

/** A worker scope <-> client pair with async (microtask) message delivery. */
function linkedPair(): { worker: FakeWorker; scope: Scope } {
  const worker: FakeWorker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (message) =>
      queueMicrotask(() => scope.onmessage?.({ data: message } as MessageEvent)),
    terminate: () => {
      worker.terminated = true;
    },
  };
  const scope: Scope = {
    onmessage: null,
    postMessage: (message) =>
      queueMicrotask(() =>
        worker.onmessage?.({ data: message } as MessageEvent),
      ),
  };
  return { worker, scope };
}

/** Run the real `exposeWorkerApi` against a given scope by borrowing `self`. */
function serve(scope: Scope, api: WorkerApi): void {
  const previous = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = scope;
  try {
    exposeWorkerApi(api);
  } finally {
    (globalThis as { self?: unknown }).self = previous;
  }
}

const demoApi = {
  echo: (value: string) => value,
  add: (a: number, b: number) => a + b,
  slow: async (value: string) => {
    await new Promise((r) => setTimeout(r, 5));
    return value.toUpperCase();
  },
  boom: () => {
    throw new Error("kaboom");
  },
};
type DemoApi = typeof demoApi;

describe("worker-rpc", () => {
  it("resolves ready after the handshake and returns method results", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready } = createWorkerClient<DemoApi>(worker as never);

    await ready;
    expect(await client.echo("hi")).toBe("hi");
    expect(await client.add(2, 3)).toBe(5);
  });

  it("correlates concurrent calls to their own responses", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready } = createWorkerClient<DemoApi>(worker as never);
    await ready;

    const [a, b, c] = await Promise.all([
      client.slow("a"),
      client.echo("b"),
      client.slow("c"),
    ]);
    expect([a, b, c]).toEqual(["A", "b", "C"]);
  });

  it("rejects with a non-fatal WorkerRpcError when a method throws", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready } = createWorkerClient<DemoApi>(worker as never);
    await ready;

    await expect(client.boom()).rejects.toMatchObject({
      name: "WorkerRpcError",
      workerDead: false,
    });
    // Client still works after a method-level failure.
    expect(await client.echo("still-alive")).toBe("still-alive");
  });

  it("rejects unknown methods", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready } = createWorkerClient<DemoApi & { nope: () => void }>(
      worker as never,
    );
    await ready;
    await expect(client.nope()).rejects.toBeInstanceOf(WorkerRpcError);
  });

  it("rejects ready with a fatal error when the handshake times out", async () => {
    const { worker } = linkedPair(); // never served → no READY message
    const { ready } = createWorkerClient<DemoApi>(worker as never, {
      readyTimeoutMs: 20,
    });
    await expect(ready).rejects.toMatchObject({
      name: "WorkerRpcError",
      workerDead: true,
    });
  });

  it("fails all pending calls when the worker crashes", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready } = createWorkerClient<DemoApi>(worker as never);
    await ready;

    const pending = client.slow("x");
    worker.onerror?.({ message: "segfault" });
    await expect(pending).rejects.toMatchObject({ workerDead: true });
    // Subsequent calls fail fast as dead.
    await expect(client.echo("y")).rejects.toMatchObject({ workerDead: true });
  });

  it("terminate() kills the worker and fails outstanding work", async () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client, ready, terminate } = createWorkerClient<DemoApi>(
      worker as never,
    );
    await ready;

    const pending = client.slow("x");
    terminate();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toMatchObject({ workerDead: true });
  });

  it("does not treat a `then` property probe as an RPC method", () => {
    const { worker, scope } = linkedPair();
    serve(scope, demoApi);
    const { client } = createWorkerClient<DemoApi>(worker as never);
    expect((client as { then?: unknown }).then).toBeUndefined();
  });
});
