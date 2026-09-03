/**
 * The git worker boundary, transport-agnostic: a host (typically a Web
 * Worker, but any message channel — or an in-process call in tests/fallback)
 * serves `createGitWorkerApi`, and callers consume `createRpcGitService`, a
 * `GitService` whose every method funnels through one `gitCall` function.
 *
 * Errors never throw across the boundary. `gitCall` returns a discriminated
 * result whose error arm is pure data (`GitBoundaryError`), and the client
 * facade rehydrates it — `GitError` natively (it lives in this package),
 * anything else via the caller-supplied `reviveError` hook, so an app can
 * round-trip its own error classes (e.g. a filesystem error whose `type`
 * drives access-loss handling) without this package knowing them.
 */
import { IsomorphicGitService } from "./isomorphicGitService";
import {
  GitError,
  type GitErrorCode,
  type GitRepoRef,
  type GitService,
  type GitStorageHost,
} from "./types";

export type GitServiceMethod = keyof GitService;

export type GitBoundaryError =
  | { kind: "git"; code: GitErrorCode; message: string }
  | { kind: "fs"; type: string; path?: string; message: string }
  | { kind: "unknown"; message: string };

export type GitCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: GitBoundaryError };

/** The host side's API surface; serve it over any RPC transport. */
export interface GitWorkerApi {
  gitCall(
    repo: GitRepoRef,
    method: GitServiceMethod,
    args: unknown[],
  ): Promise<GitCallResult>;
  /** Drop the repo's service (and its object cache). */
  disposeRepo(gitDir: string): Promise<void>;
}

/**
 * An app error that should cross the boundary with its discriminant intact:
 * anything named `FsError` carrying a string `type` (the desktop/browser
 * adapters' shared filesystem error class). Matched structurally — this
 * package must not import app modules.
 */
function isFsErrorLike(
  error: unknown,
): error is Error & { type: string; path?: string } {
  return (
    error instanceof Error &&
    error.name === "FsError" &&
    typeof (error as { type?: unknown }).type === "string"
  );
}

export function serializeGitBoundaryError(error: unknown): GitBoundaryError {
  if (error instanceof GitError) {
    return { kind: "git", code: error.code, message: error.message };
  }
  if (isFsErrorLike(error)) {
    return {
      kind: "fs",
      type: error.type,
      path: typeof error.path === "string" ? error.path : undefined,
      message: error.message,
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Host side: one `IsomorphicGitService` per gitdir, created on first call
 * via the caller's storage-host factory, held until `disposeRepo`.
 */
export function createGitWorkerApi(
  createHost: (repo: GitRepoRef) => GitStorageHost,
): GitWorkerApi {
  const services = new Map<string, IsomorphicGitService>();

  const serviceFor = (repo: GitRepoRef): IsomorphicGitService => {
    let service = services.get(repo.gitDir);
    if (!service) {
      service = new IsomorphicGitService(createHost(repo), repo);
      services.set(repo.gitDir, service);
    }
    return service;
  };

  return {
    async gitCall(repo, method, args) {
      try {
        const service = serviceFor(repo);
        const fn = service[method] as (...a: unknown[]) => Promise<unknown>;
        if (typeof fn !== "function") {
          throw new GitError(
            "InvalidInput",
            `Unknown git service method: ${String(method)}`,
          );
        }
        const value = await fn.apply(service, args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: serializeGitBoundaryError(error) };
      }
    },

    async disposeRepo(gitDir) {
      services.delete(gitDir);
    },
  };
}

/**
 * The client side's transport: forward one call to the host. A rejection
 * (as opposed to an `ok: false` result) means the transport itself failed
 * or an in-process fallback threw natively — it propagates unchanged.
 */
export type GitBoundaryCall = (
  method: GitServiceMethod,
  args: unknown[],
) => Promise<GitCallResult>;

export function reviveGitBoundaryError(
  error: GitBoundaryError,
  reviveError?: (error: GitBoundaryError) => Error | undefined,
): Error {
  const revived = reviveError?.(error);
  if (revived) return revived;
  if (error.kind === "git") {
    return new GitError(error.code, error.message);
  }
  return new Error(error.message);
}

const GIT_SERVICE_METHODS = [
  "init",
  "status",
  "add",
  "remove",
  "unstage",
  "commit",
  "addAllAndCommit",
  "revertCommit",
  "abortRevert",
  "listBranches",
  "createBranch",
  "switchBranch",
  "checkoutPaths",
  "log",
  "readTextFile",
  "fetch",
  "pull",
  "push",
] as const satisfies readonly GitServiceMethod[];

/** Client side: a `GitService` whose methods all route through `call`. */
export function createRpcGitService(
  call: GitBoundaryCall,
  reviveError?: (error: GitBoundaryError) => Error | undefined,
): GitService {
  const service: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of GIT_SERVICE_METHODS) {
    service[method] = async (...args: unknown[]) => {
      const result = await call(method, args);
      if (result.ok) return result.value;
      throw reviveGitBoundaryError(result.error, reviveError);
    };
  }
  return service as unknown as GitService;
}
