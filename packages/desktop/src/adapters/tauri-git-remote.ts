/**
 * The desktop's git HTTP and credentials surfaces, over Tauri commands
 * (`src-tauri/src/git_http.rs`, `credentials.rs`). The request body travels
 * raw on the IPC channel and its metadata in one percent-encoded header;
 * the response comes back as one buffer: a 4-byte big-endian length, the
 * JSON `{status, headers}` it measures, then the body.
 *
 * Rust holds the tokens: `credentials.set` hands one over once, there is no
 * way to read it back, and `git_http_request` adds `Authorization` itself
 * for a request whose URL is under the credential it names.
 */
import type {
  CredentialsSurface,
  GitHttpRequestSpec,
  GitHttpResponseSpec,
  GitHttpSurface,
} from "./platform-adapter.interface";

/** The header carrying a request's metadata. */
export const GIT_HTTP_META_HEADER = "x-notefig-git-http";

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<T>;

export function encodeGitHttpMeta(request: GitHttpRequestSpec): string {
  return encodeURIComponent(
    JSON.stringify({
      url: request.url,
      method: request.method,
      headers: request.headers,
      credential: request.credential ?? null,
    }),
  );
}

export function decodeGitHttpResponse(buffer: ArrayBuffer): GitHttpResponseSpec {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) throw new Error("Truncated git HTTP response.");
  const metaLength = new DataView(buffer).getUint32(0);
  if (bytes.length < 4 + metaLength) {
    throw new Error("Truncated git HTTP response metadata.");
  }
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLength)),
  ) as { status: number; headers: Record<string, string> };
  return {
    status: meta.status,
    headers: meta.headers,
    body: bytes.slice(4 + metaLength),
  };
}

export function createTauriGitHttp(invoke: Invoke): GitHttpSurface {
  return {
    supported: true,
    async request(request) {
      const buffer = await invoke<ArrayBuffer>(
        "git_http_request",
        request.body ?? new Uint8Array(0),
        { headers: { [GIT_HTTP_META_HEADER]: encodeGitHttpMeta(request) } },
      );
      return decodeGitHttpResponse(buffer);
    },
  };
}

export function createTauriCredentials(invoke: Invoke): CredentialsSurface {
  return {
    supported: true,
    set: (remoteKey, username, token) =>
      invoke<void>("credentials_set", { remoteKey, username, token }),
    has: (remoteKey) => invoke<boolean>("credentials_has", { remoteKey }),
    delete: (remoteKey) => invoke<void>("credentials_delete", { remoteKey }),
  };
}
