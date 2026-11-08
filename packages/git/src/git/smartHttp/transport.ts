/**
 * The ports, as two clients over the same authorized send: a
 * `GitTransport` for our receive-pack push (one stateless exchange per
 * call; an SSH transport later implements the same two calls over a byte
 * stream), and an isomorphic-git `HttpClient` for its `listServerRefs`
 * and `fetch`.
 */
import type { HttpClient } from "isomorphic-git";

import { concatBytes } from "./pktLine";
import type {
  GitAuthProvider,
  GitHttpClient,
  GitHttpRequest,
  GitHttpResponse,
  GitRemote,
} from "../types";

export type GitServiceName = "git-upload-pack" | "git-receive-pack";

export interface GitTransport {
  /** The service's v0 ref advertisement (`info/refs`), for its capabilities. */
  advertise(service: GitServiceName): Promise<Uint8Array>;
  /** Send one request body to the service and return the whole reply. */
  exchange(service: GitServiceName, body: Uint8Array): Promise<Uint8Array>;
}

/** The remote answered with a non-2xx status. */
export class GitHttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHttpStatusError";
  }
}

/** No response arrived: the http port rejected (network failure, timeout). */
export class GitTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitTransportError";
  }
}

/** A `git/` user agent: hosts tell git clients from browsers by it. */
export const USER_AGENT = "git/notefig";

function serviceUrl(remote: GitRemote, path: string): string {
  return `${remoteUrl(remote)}/${path}`;
}

function statusMessage(status: number, url: string): string {
  const where = url.replace(/\/\/[^@/]*@/, "//");
  return `HTTP ${status} from ${where}`;
}

/**
 * Run the request through the auth decorator and the http port. A port
 * rejection (no response) becomes `GitTransportError`; any status is
 * handed back for the caller to judge.
 */
function authorizedSend(
  http: GitHttpClient,
  auth?: GitAuthProvider,
): (request: GitHttpRequest) => Promise<GitHttpResponse> {
  return async (request) => {
    const authorized = auth ? await auth.authorize(request) : request;
    try {
      return await http.request(authorized);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitTransportError(`request failed: ${reason}`, error);
    }
  };
}

/**
 * Smart HTTP over the injected ports. Status mapping happens here
 * (non-2xx → `GitHttpStatusError`) and in `toGitError`.
 */
export function createHttpTransport(
  remote: GitRemote,
  http: GitHttpClient,
  auth?: GitAuthProvider,
): GitTransport {
  const request = authorizedSend(http, auth);
  const send = async (req: GitHttpRequest): Promise<Uint8Array> => {
    const response = await request(req);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHttpStatusError(
        response.status,
        statusMessage(response.status, req.url),
      );
    }
    return response.body;
  };

  return {
    advertise(service) {
      return send({
        url: serviceUrl(remote, `info/refs?service=${service}`),
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        credential: remote.credential,
      });
    },
    exchange(service, body) {
      return send({
        url: serviceUrl(remote, service),
        method: "POST",
        headers: {
          "Content-Type": `application/x-${service}-request`,
          Accept: `application/x-${service}-result`,
          "User-Agent": USER_AGENT,
        },
        body,
        credential: remote.credential,
      });
    },
  };
}

async function collectBody(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined,
): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return concatBytes(parts);
}

async function* once(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes;
}

/**
 * Our ports as isomorphic-git's `HttpClient`, for one remote: every
 * request carries `remote.credential` for the auth decorator or the http
 * port to resolve, so isomorphic-git never sees a secret (no `onAuth`).
 * Statuses go back as they came; isomorphic-git raises `HttpError`.
 */
export function createIsomorphicHttpClient(
  remote: GitRemote,
  http: GitHttpClient,
  auth?: GitAuthProvider,
): HttpClient {
  const request = authorizedSend(http, auth);
  return {
    async request({ url, method = "GET", headers = {}, body }) {
      const response = await request({
        url,
        method: method === "POST" ? "POST" : "GET",
        headers: { "User-Agent": USER_AGENT, ...headers },
        body: await collectBody(body),
        credential: remote.credential,
      });
      const lowered: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        lowered[key.toLowerCase()] = value;
      }
      return {
        url,
        method,
        statusCode: response.status,
        statusMessage: "",
        headers: lowered,
        body: once(response.body),
      };
    },
  };
}

/** The remote's URL as isomorphic-git joins paths onto it. */
export function remoteUrl(remote: GitRemote): string {
  return remote.url.replace(/\/+$/, "");
}
