import { describe, expect, it } from "vitest";
import { importRsaPrivateKey, remoteKeySet, signJwt, verifyJwt } from "./jwt";
import { testSigner } from "./testing-jwt";

const NOW = Date.UTC(2026, 9, 16, 12);
const seconds = NOW / 1000;
const options = { issuer: "https://issuer.test", audience: "https://intake.test", now: () => NOW };

function claims(overrides: Record<string, unknown> = {}) {
  return { iss: options.issuer, aud: options.audience, exp: seconds + 300, sub: "me", ...overrides };
}

describe("verifyJwt", () => {
  it("returns the claims of a token signed by the issuer's key", async () => {
    const signer = await testSigner();
    const token = await signer.sign(claims());
    expect(await verifyJwt(token, signer.keys, options)).toMatchObject({ sub: "me" });
  });

  it("accepts an audience list that includes the service", async () => {
    const signer = await testSigner();
    const token = await signer.sign(claims({ aud: ["other", options.audience] }));
    expect(await verifyJwt(token, signer.keys, options)).toBeDefined();
  });

  it.each([
    ["another issuer", { iss: "https://evil.test" }],
    ["another audience", { aud: "https://other.test" }],
    ["an expired token", { exp: seconds - 3600 }],
    ["a token not valid yet", { nbf: seconds + 3600 }],
    ["a token without an expiry", { exp: undefined }],
  ])("rejects %s", async (_, overrides) => {
    const signer = await testSigner();
    const token = await signer.sign(claims(overrides));
    expect(await verifyJwt(token, signer.keys, options)).toBeUndefined();
  });

  it("rejects a token signed by a key the issuer didn't publish", async () => {
    const issuer = await testSigner("shared-kid");
    const forger = await testSigner("shared-kid");
    const token = await forger.sign(claims());
    expect(await verifyJwt(token, issuer.keys, options)).toBeUndefined();
  });

  it("rejects a tampered payload and garbage", async () => {
    const signer = await testSigner();
    const [header, , signature] = (await signer.sign(claims())).split(".");
    const forged = btoa(JSON.stringify(claims({ sub: "admin" }))).replace(/=+$/, "");
    expect(await verifyJwt(`${header}.${forged}.${signature}`, signer.keys, options)).toBeUndefined();
    expect(await verifyJwt("not-a-token", signer.keys, options)).toBeUndefined();
  });
});

describe("importRsaPrivateKey", () => {
  it.each(["pkcs8Pem", "pkcs1Pem"] as const)("signs with a %s key", async (form) => {
    const signer = await testSigner();
    const key = await importRsaPrivateKey(signer[form]);
    const token = await signJwt(claims(), key, "test-key");
    expect(await verifyJwt(token, signer.keys, options)).toBeDefined();
  });
});

describe("remoteKeySet", () => {
  it("fetches the published keys once, and again for an unknown kid", async () => {
    const signer = await testSigner("k1");
    const jwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
    let fetches = 0;
    const keys = remoteKeySet("https://issuer.test/jwks", async () => {
      fetches++;
      return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
    });
    expect(await keys.key("k1")).toBeDefined();
    expect(await keys.key("k1")).toBeDefined();
    expect(fetches).toBe(1);
    expect(await keys.key("k2")).toBeUndefined();
    expect(fetches).toBe(2);
  });
});
