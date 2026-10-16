import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./github";
import { testSigner } from "./testing-jwt";

const NOW = Date.UTC(2026, 9, 16, 12);
function base64UrlBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const inputs = { build_id: "b1", issue: "MET-1", title: "Title", body: "Body" };

async function setup() {
  const app = await testSigner();
  const requests: { url: string; init?: RequestInit }[] = [];
  let now = NOW;
  const github = createGitHubClient({
    appId: "12345",
    privateKeyPem: app.pkcs1Pem,
    repository: "notefig/notefig",
    now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/installation")) return Response.json({ id: 99 });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_installation", expires_at: new Date(now + 3_600_000).toISOString() });
      }
      return new Response(null, { status: 204 });
    },
  });
  const advance = (ms: number) => {
    now += ms;
  };
  return { app, github, requests, advance };
}

describe("createGitHubClient", () => {
  it("dispatches agent-build.yml on main with a token scoped to Actions", async () => {
    const { app, github, requests } = await setup();
    await github.dispatchBuild(inputs);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/notefig/notefig/installation",
      "https://api.github.com/app/installations/99/access_tokens",
      "https://api.github.com/repos/notefig/notefig/actions/workflows/agent-build.yml/dispatches",
    ]);
    const appJwt = String(new Headers(requests[0].init?.headers).get("authorization")).slice(7);
    const [header, payload, signature] = appJwt.split(".");
    const signed = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      app.publicKey,
      base64UrlBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(signed).toBe(true);
    expect(JSON.parse(atob(payload))).toEqual({ iss: "12345", iat: NOW / 1000 - 60, exp: NOW / 1000 + 540 });
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      repositories: ["notefig"],
      permissions: { actions: "write" },
    });
    expect(new Headers(requests[2].init?.headers).get("authorization")).toBe("Bearer ghs_installation");
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({ ref: "main", inputs });
  });

  it("reuses the installation token until it nears expiry", async () => {
    const { github, requests, advance } = await setup();
    await github.dispatchBuild(inputs);
    await github.dispatchBuild(inputs);
    expect(requests).toHaveLength(4);
    advance(56 * 60_000);
    await github.dispatchBuild(inputs);
    expect(requests).toHaveLength(7);
  });
});
