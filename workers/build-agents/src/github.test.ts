import { describe, expect, it } from "vitest";
import { appJwt, logTail, pkcs8 } from "./github.ts";

function pem(label: string, der: ArrayBuffer): string {
	const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
	return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

async function keyPair() {
	return (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
}

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

describe("appJwt", () => {
	it("signs a short-lived RS256 token the public key verifies", async () => {
		const { privateKey, publicKey } = await keyPair();
		const key = pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
		const now = Date.parse("2026-10-19T12:00:00Z");
		const jwt = await appJwt({ appId: "123", privateKey: key }, now);
		const [header, payload, signature] = jwt.split(".");
		expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
		expect(decode(payload)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "123" });
		const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
	});
});

describe("pkcs8", () => {
	it("wraps a PKCS#1 key, as GitHub issues them, into the PKCS#8 WebCrypto imports", async () => {
		const { privateKey } = await keyPair();
		const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
		// The PKCS#1 key is the OCTET STRING at the end of the PKCS#8 structure: strip the 26-byte prefix.
		const rsa = pem("RSA PRIVATE KEY", der.slice(26).buffer);
		expect(pkcs8(rsa)).toEqual(der);
	});
});

describe("logTail", () => {
	it("keeps the last lines without timestamps, colours or group markers", () => {
		const log = [
			"2026-10-19T07:10:01.1234567Z ##[group]Run npm test",
			"2026-10-19T07:10:02.1234567Z \x1b[31mnot ok 3 - answers 429 when rate limited\x1b[0m",
			"2026-10-19T07:10:02.2234567Z   expected: 418",
			"2026-10-19T07:10:03.1234567Z ##[endgroup]",
			"2026-10-19T07:10:03.2234567Z ##[error]Process completed with exit code 1.",
		].join("\n");
		expect(logTail(log)).toBe("not ok 3 - answers 429 when rate limited\n  expected: 418\n##[error]Process completed with exit code 1.");
		expect(logTail(log, 1)).toBe("##[error]Process completed with exit code 1.");
	});
});
