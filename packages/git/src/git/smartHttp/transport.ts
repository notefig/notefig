/**
 * The protocol client talks to a `GitTransport`, never to HTTP directly:
 * one stateless request/response exchange per call, the shape smart HTTP
 * has. An SSH transport later implements the same two calls over a byte
 * stream (write the request, read until the response's final flush).
 */
import type {
  GitAuthProvider,
  GitHttpClient,
  GitHttpRequest,
  GitRemote,
} from "../types";

export type GitServiceName = "git-upload-pack" | "git-receive-pack";

export interface GitTransport {
  /** The service's v0 ref advertisement (`info/refs`), for its capabilities. */
  advertise(service: GitServiceName): Promise<Uint8Array>;
  /**
   * Send one request body to the service and return the whole reply.
   * `protocolV2` asks for protocol version 2 (upload-pack only).
   */
  exchange(
    service: GitServiceName,
    body: Uint8Array,
    options: { protocolV2: boolean },
  ): Promise<Uint8Array>;
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

const USER_AGENT = "git/notefig";

function serviceUrl(remote: GitRemote, path: string): string {
  const base = remote.url.replace(/\/+$/, "");
  return `${base}/${path}`;
}

function statusMessage(status: number, url: string): string {
  const where = url.replace(/\/\/[^@/]*@/, "//");
  return `HTTP ${status} from ${where}`;
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
  const send = async (request: GitHttpRequest): Promise<Uint8Array> => {
    const authorized = auth ? await auth.authorize(request) : request;
    let response;
    try {
      response = await http.request(authorized);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitTransportError(`request failed: ${reason}`, error);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GitHttpStatusError(
        response.status,
        statusMessage(response.status, request.url),
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
    exchange(service, body, { protocolV2 }) {
      const headers: Record<string, string> = {
        "Content-Type": `application/x-${service}-request`,
        Accept: `application/x-${service}-result`,
        "User-Agent": USER_AGENT,
      };
      if (protocolV2) headers["Git-Protocol"] = "version=2";
      return send({
        url: serviceUrl(remote, service),
        method: "POST",
        headers,
        body,
        credential: remote.credential,
      });
    },
  };
}
