/**
 * A git remote for tests: system `git http-backend` run as a CGI per
 * request, behind the `GitHttpClient` port (no server, no sockets). System
 * git is a test-only dependency.
 */
import { spawn } from "node:child_process";

import type { GitHttpClient, GitHttpRequest, GitHttpResponse } from "./git/types";

function cgiResponse(output: Buffer): GitHttpResponse {
  let split = output.indexOf("\r\n\r\n");
  let sep = 4;
  if (split < 0) {
    split = output.indexOf("\n\n");
    sep = 2;
  }
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, split).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10);
    else if (name) headers[name] = value;
  }
  return { status, headers, body: new Uint8Array(output.subarray(split + sep)) };
}

/**
 * Serve the bare repos under `root` (`https://any-host/<name>.git`). Pushes
 * need `http.receivepack` set on the bare repo.
 */
export function httpBackend(root: string): GitHttpClient {
  return {
    request(request: GitHttpRequest) {
      const url = new URL(request.url);
      const body = Buffer.from(request.body ?? new Uint8Array(0));
      const header = (name: string) =>
        Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
      return new Promise((resolve, reject) => {
        const child = spawn("git", ["http-backend"], {
          env: {
            PATH: process.env.PATH,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: root,
            PATH_INFO: decodeURIComponent(url.pathname),
            QUERY_STRING: url.search.replace(/^\?/, ""),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: header("content-type"),
            CONTENT_LENGTH: String(body.length),
            HTTP_GIT_PROTOCOL: header("git-protocol"),
            REMOTE_USER: "tester",
            REMOTE_ADDR: "127.0.0.1",
          },
        });
        const out: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.resume();
        child.on("error", reject);
        child.on("close", () => resolve(cgiResponse(Buffer.concat(out))));
        child.stdin.end(body);
      });
    },
  };
}
