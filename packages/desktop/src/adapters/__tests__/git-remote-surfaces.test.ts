import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import {
  TauriPlatformAdapter,
  decodeGitHttpResponse,
  encodeGitHttpMeta,
} from "../tauri-adapter";
import { BrowserPlatformAdapter } from "../browser-adapter";
import {
  PlatformUnsupportedError,
  type GitHttpRequestSpec,
} from "../platform-adapter.interface";

/** The buffer `git_http.rs` answers with. */
function framed(
  status: number,
  headers: Record<string, string>,
  body: Uint8Array,
) {
  const meta = new TextEncoder().encode(JSON.stringify({ status, headers }));
  const out = new Uint8Array(4 + meta.length + body.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(body, 4 + meta.length);
  return out.buffer;
}

const request: GitHttpRequestSpec = {
  url: "https://github.com/o/r.git/git-upload-pack",
  method: "POST",
  headers: { "Git-Protocol": "version=2" },
};

describe("tauri git HTTP surface", () => {
  it("sends the body raw and decodes the framed answer", async () => {
    withMockedTauri({
      git_http_request: () =>
        framed(
          200,
          { "content-type": "application/x-git-upload-pack-result" },
          new Uint8Array([1, 2, 3]),
        ),
    });
    const { gitHttp } = new TauriPlatformAdapter();

    const response = await gitHttp.request({
      ...request,
      body: new Uint8Array([9, 9]),
    });

    expect(gitHttp.supported).toBe(true);
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      body: new Uint8Array([1, 2, 3]),
    });
  });

  it("puts the metadata (never a secret) in one header", () => {
    expect(JSON.parse(decodeURIComponent(encodeGitHttpMeta(request)))).toEqual(
      request,
    );
  });

  it("rejects a truncated answer", () => {
    expect(() => decodeGitHttpResponse(new ArrayBuffer(2))).toThrow(
      /Truncated/,
    );
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 100);
    expect(() => decodeGitHttpResponse(bad.buffer)).toThrow(/Truncated/);
  });

  it("passes a failed request (no response) through as a rejection", async () => {
    withMockedTauri({
      git_http_request: () => {
        throw "operation timed out";
      },
    });
    const { gitHttp } = new TauriPlatformAdapter();
    await expect(
      gitHttp.request({
        url: "https://h/r.git/info/refs",
        method: "GET",
        headers: {},
      }),
    ).rejects.toBe("operation timed out");
  });
});

describe("tauri credentials surface", () => {
  it("names the remote and answers with the credential in use, never a secret", async () => {
    const using = { source: "git", username: "ada" };
    const tauri = withMockedTauri({
      credentials_status: () => using,
      credentials_set: () => ({ source: "stored", username: "x-access-token" }),
      credentials_delete: () => using,
    });
    const { credentials } = new TauriPlatformAdapter();
    const url = "https://github.com/o/r.git";

    await expect(credentials.status(url, "/repo")).resolves.toEqual(using);
    await expect(credentials.set(url, "/repo", "secret")).resolves.toMatchObject({ source: "stored" });
    await expect(credentials.delete(url, "/repo")).resolves.toEqual(using);
    expect(tauri.invocations.map(({ cmd, payload }) => [cmd, payload])).toEqual([
      ["credentials_status", { remoteUrl: url, repoPath: "/repo" }],
      ["credentials_set", { remoteUrl: url, repoPath: "/repo", token: "secret" }],
      ["credentials_delete", { remoteUrl: url, repoPath: "/repo" }],
    ]);
  });
});

describe("browser git remote surfaces", () => {
  it("say they are unsupported", async () => {
    const { gitHttp, credentials } = new BrowserPlatformAdapter();
    expect(gitHttp.supported).toBe(false);
    expect(credentials.supported).toBe(false);
    await expect(
      gitHttp.request({ url: "https://h/r.git", method: "GET", headers: {} }),
    ).rejects.toBeInstanceOf(PlatformUnsupportedError);
    await expect(credentials.status("https://h/r.git", "/repo")).rejects.toBeInstanceOf(
      PlatformUnsupportedError,
    );
  });
});
