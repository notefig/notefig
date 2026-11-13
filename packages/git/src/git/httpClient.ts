import { Buffer } from "buffer";
import type { HttpClient } from "isomorphic-git";

import { GitError, type GitHttpClient } from "./types";

async function collect(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * `ssh://…` or git's `[user@]host:path`, but not a Windows drive (`C:\\…`), a
 * `scheme://` URL or a `helper::address`.
 */
export function isSshRemote(url: string): boolean {
  if (url.startsWith("ssh://")) return true;
  if (/^[A-Za-z]:[\\/]/.test(url)) return false;
  return /^(?:[^/@:\s]+@)?(?:\[[^\]\s]+\]|[^/@:\s]+):(?!\/\/|:).+/.test(url);
}

/**
 * What isomorphic-git is told an SSH remote's URL is: it refuses any scheme
 * but http(s), and every request it makes goes through our port anyway. The
 * desktop port recognises this host and serves the request over ssh.
 */
export function sshBridgeUrl(url: string): string {
  return `https://ssh.notefig.invalid/${encodeURIComponent(url)}`;
}

/**
 * isomorphic-git's `HttpClient` over our port, for one remote. Each
 * request carries the remote's credential reference for the port to
 * authenticate with, so isomorphic-git never holds a secret and `onAuth`
 * is unused. A port rejection (no response) becomes `Network`; statuses go
 * back as they came, for isomorphic-git to raise as `HttpError`.
 */
export function toIsomorphicHttp(
  http: GitHttpClient,
  credential?: string,
): HttpClient {
  return {
    async request({ url, method = "GET", headers = {}, body }) {
      const request = {
        url,
        method: method === "POST" ? ("POST" as const) : ("GET" as const),
        headers,
        body: body ? await collect(body) : undefined,
        credential,
      };
      let response;
      try {
        response = await http.request(request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new GitError(
          "Network",
          `No response from ${url}: ${reason}`,
          error,
        );
      }
      // isomorphic-git reads `content-type`, so names must be lowercase.
      const lowered: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        lowered[name.toLowerCase()] = value;
      }
      const bytes = response.body;
      return {
        url,
        method,
        statusCode: response.status,
        statusMessage: "",
        headers: lowered,
        body: (async function* () {
          yield bytes;
        })(),
      };
    },
  };
}

/**
 * Adds `Authorization: Basic …` for the credential a request names, for
 * Node and tests where JS may hold the secret. Desktop's port
 * authenticates in Rust instead.
 */
export function withBasicAuth(
  http: GitHttpClient,
  credentials: Record<string, { username: string; password: string }>,
): GitHttpClient {
  return {
    request(request) {
      const found = request.credential && credentials[request.credential];
      if (!found) return http.request(request);
      const token = Buffer.from(`${found.username}:${found.password}`).toString(
        "base64",
      );
      return http.request({
        ...request,
        headers: { ...request.headers, Authorization: `Basic ${token}` },
      });
    },
  };
}
