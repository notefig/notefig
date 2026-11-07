/**
 * Ready-made port implementations for environments where JS may hold the
 * credential (Node scripts, tests). Desktop injects its own http port that
 * authenticates in Rust and uses neither of these.
 */
import { Buffer } from "buffer";

import type {
  GitAuthProvider,
  GitHttpClient,
  GitHttpRequest,
  GitHttpResponse,
} from "../types";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A `GitHttpClient` over a WHATWG `fetch` (Node's keeps connections alive). */
export function createFetchHttpClient(fetchImpl: FetchLike): GitHttpClient {
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

/** The environment's global `fetch` as an http port, when it has one. */
export function defaultHttpClient(): GitHttpClient | undefined {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  return typeof globalFetch === "function"
    ? createFetchHttpClient(globalFetch.bind(globalThis) as FetchLike)
    : undefined;
}

export interface GitBasicCredential {
  username: string;
  password: string;
}

/**
 * Adds `Authorization: Basic …` for the credential a request names
 * (`GitRemote.credential`). Requests naming no known credential go out
 * unauthenticated, so the remote's 401 surfaces as `AuthRequired`.
 */
export function createBasicAuthProvider(
  credentials: Record<string, GitBasicCredential>,
): GitAuthProvider {
  return {
    authorize(request) {
      const credential = request.credential
        ? credentials[request.credential]
        : undefined;
      if (!credential) return request;
      const token = Buffer.from(
        `${credential.username}:${credential.password}`,
        "utf8",
      ).toString("base64");
      return {
        ...request,
        headers: { ...request.headers, Authorization: `Basic ${token}` },
      };
    },
  };
}
