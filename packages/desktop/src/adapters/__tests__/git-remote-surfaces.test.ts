import { describe, expect, it, vi } from "vitest";
import {
  GIT_HTTP_META_HEADER,
  createTauriCredentials,
  createTauriGitHttp,
  decodeGitHttpResponse,
} from "../tauri-git-remote";
import {
  createUnsupportedCredentials,
  createUnsupportedGitHttp,
} from "../browser-git-remote";
import { PlatformUnsupportedError } from "../platform-adapter.interface";

/** The buffer `git_http.rs` answers with. */
function framed(status: number, headers: Record<string, string>, body: Uint8Array) {
  const meta = new TextEncoder().encode(JSON.stringify({ status, headers }));
  const out = new Uint8Array(4 + meta.length + body.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(body, 4 + meta.length);
  return out.buffer;
}

describe("tauri git HTTP surface", () => {
  it("sends the body raw and the metadata (no secret) in one header", async () => {
    const invoke = vi.fn(async () =>
      framed(200, { "content-type": "application/x-git-upload-pack-result" }, new Uint8Array([1, 2, 3])),
    );
    const http = createTauriGitHttp(invoke as never);
    const body = new Uint8Array([9, 9]);

    const response = await http.request({
      url: "https://github.com/o/r.git/git-upload-pack",
      method: "POST",
      headers: { "Git-Protocol": "version=2" },
      body,
      credential: "github.com/o/r",
    });

    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      body: new Uint8Array([1, 2, 3]),
    });
    const [command, sent, options] = invoke.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      { headers: Record<string, string> },
    ];
    expect(command).toBe("git_http_request");
    expect(sent).toBe(body);
    expect(JSON.parse(decodeURIComponent(options.headers[GIT_HTTP_META_HEADER]))).toEqual({
      url: "https://github.com/o/r.git/git-upload-pack",
      method: "POST",
      headers: { "Git-Protocol": "version=2" },
      credential: "github.com/o/r",
    });
  });

  it("rejects a truncated answer", () => {
    expect(() => decodeGitHttpResponse(new ArrayBuffer(2))).toThrow(/Truncated/);
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 100);
    expect(() => decodeGitHttpResponse(bad.buffer)).toThrow(/Truncated/);
  });

  it("passes a failed request (no response) through as a rejection", async () => {
    const http = createTauriGitHttp((async () => {
      throw "operation timed out";
    }) as never);
    await expect(
      http.request({ url: "https://h/r.git/info/refs", method: "GET", headers: {} }),
    ).rejects.toBe("operation timed out");
  });
});

describe("tauri credentials surface", () => {
  it("can store, check and delete a token, and has no way to read it", async () => {
    const invoke = vi.fn(async () => true);
    const credentials = createTauriCredentials(invoke as never);

    await credentials.set("github.com/o/r", "x-access-token", "secret");
    await credentials.has("github.com/o/r");
    await credentials.delete("github.com/o/r");

    expect(invoke.mock.calls).toEqual([
      ["credentials_set", { remoteKey: "github.com/o/r", username: "x-access-token", token: "secret" }],
      ["credentials_has", { remoteKey: "github.com/o/r" }],
      ["credentials_delete", { remoteKey: "github.com/o/r" }],
    ]);
    expect(Object.keys(credentials).sort()).toEqual(["delete", "has", "set", "supported"]);
  });
});

describe("browser surfaces", () => {
  it("say sync is unsupported", async () => {
    const http = createUnsupportedGitHttp();
    const credentials = createUnsupportedCredentials();
    expect(http.supported).toBe(false);
    expect(credentials.supported).toBe(false);
    await expect(
      http.request({ url: "https://h/r.git", method: "GET", headers: {} }),
    ).rejects.toBeInstanceOf(PlatformUnsupportedError);
    await expect(credentials.has("h/r")).rejects.toBeInstanceOf(PlatformUnsupportedError);
  });
});
