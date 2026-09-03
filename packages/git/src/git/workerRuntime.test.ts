/**
 * The worker runtime's init choreography, against a fake worker scope: the
 * init message's globals must be pinned on `globalThis` BEFORE the app's
 * wiring loads (that ordering is the runtime's whole reason to exist), and
 * non-init traffic must not trigger the boot.
 */
import { startGitWorker, type GitWorkerInitMessage } from "./workerRuntime";
import type { GitWorkerApi } from "./workerBoundary";
import type { GitStorageHost } from "./types";

type Handler = (event: MessageEvent) => void;

function makeScope() {
  const handlers = new Set<Handler>();
  return {
    addEventListener: (_type: "message", handler: Handler) =>
      handlers.add(handler),
    removeEventListener: (_type: "message", handler: Handler) =>
      handlers.delete(handler),
    emit: (data: unknown) => {
      for (const handler of [...handlers]) {
        handler({ data } as MessageEvent);
      }
    },
    handlerCount: () => handlers.size,
  };
}

const TEST_GLOBAL = "__GIT_WORKER_RUNTIME_TEST__";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[TEST_GLOBAL];
});

describe("startGitWorker", () => {
  it("pins init globals before loading the wiring, then serves the api", async () => {
    const scope = makeScope();
    let globalAtWiringLoad: unknown = "wiring-not-loaded";
    let exposed: GitWorkerApi | undefined;

    startGitWorker(async () => {
      globalAtWiringLoad = (globalThis as Record<string, unknown>)[TEST_GLOBAL];
      return {
        createHost: () => ({}) as GitStorageHost,
        expose: (api) => {
          exposed = api;
        },
      };
    }, scope);

    scope.emit({ notInit: true });
    scope.emit(null);
    expect(globalAtWiringLoad).toBe("wiring-not-loaded");

    scope.emit({
      gitWorkerInit: true,
      globals: { [TEST_GLOBAL]: "windows" },
    } satisfies GitWorkerInitMessage);
    await Promise.resolve();

    expect(globalAtWiringLoad).toBe("windows");
    expect(exposed).toBeDefined();
    expect(typeof exposed?.gitCall).toBe("function");
    // One-shot: the init handler unhooks itself after the handshake.
    expect(scope.handlerCount()).toBe(0);
  });

  it("installs a Buffer global for isomorphic-git", () => {
    startGitWorker(async () => {
      throw new Error("unused");
    }, makeScope());
    expect(typeof globalThis.Buffer).toBe("function");
  });
});
