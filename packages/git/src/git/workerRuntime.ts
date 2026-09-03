/**
 * Worker-side runtime for the git boundary: everything about running
 * `createGitWorkerApi` inside a Web Worker that is not app-specific — the
 * `Buffer` global isomorphic-git expects (worker globals start without
 * one), and the init handshake that must precede the app's wiring.
 *
 * The handshake exists because a worker cannot see the host environment
 * (no `window`, no shell internals): the main thread sends one
 * `GitWorkerInitMessage` whose `globals` are pinned onto `globalThis`
 * BEFORE the app's wiring modules load, so app modules that read the
 * environment at module evaluation (e.g. a path-flavor binding keyed off
 * an OS override) see the right values. That ordering is why the wiring
 * arrives as an async thunk: the app defers its own imports into it.
 */
import { Buffer } from "buffer";

import { createGitWorkerApi, type GitWorkerApi } from "./workerBoundary";
import type { GitRepoRef, GitStorageHost } from "./types";

/** First message the main thread sends after constructing the worker. */
export interface GitWorkerInitMessage {
  gitWorkerInit: true;
  /** Pinned onto `globalThis` before the wiring modules load. */
  globals?: Record<string, unknown>;
}

/** What the app supplies: its storage host and its RPC transport. */
export interface GitWorkerWiring {
  createHost: (repo: GitRepoRef) => GitStorageHost;
  /** Serve the built API over the app's worker RPC. */
  expose: (api: GitWorkerApi) => void;
}

interface WorkerScope {
  addEventListener: (type: "message", handler: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", handler: (event: MessageEvent) => void) => void;
}

function isInitMessage(data: unknown): data is GitWorkerInitMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as GitWorkerInitMessage).gitWorkerInit === true
  );
}

/**
 * Call once at the top of a worker entry. Installs `Buffer`, waits for the
 * init message, pins its globals, then loads the wiring and starts serving.
 */
export function startGitWorker(
  createWiring: () => Promise<GitWorkerWiring>,
  // In a worker, `globalThis` IS the worker scope (`self`) — and unlike
  // `self`, it exists in this package's node-targeted type environment.
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): void {
  if (typeof globalThis.Buffer === "undefined") {
    globalThis.Buffer = Buffer;
  }

  const onInit = async (event: MessageEvent) => {
    if (!isInitMessage(event.data)) return;
    scope.removeEventListener("message", onInit);
    for (const [key, value] of Object.entries(event.data.globals ?? {})) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
    const wiring = await createWiring();
    wiring.expose(createGitWorkerApi(wiring.createHost));
  };

  scope.addEventListener("message", onInit);
}
