/**
 * RS256 JSON Web Tokens over WebCrypto, for the three tokens the service
 * handles: Cloudflare Access's on report reads, GitHub Actions' OIDC token
 * on build results (both verified against the issuer's published keys),
 * and the GitHub App's own token (signed with its private key).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEYS_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_S = 60;

export type JwtClaims = Record<string, unknown>;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(segment: string): unknown {
  return JSON.parse(decoder.decode(base64UrlDecode(segment)));
}

/** A published key set (`/.well-known/jwks`, Access's `/certs`), fetched once an hour. */
export interface KeySet {
  key(kid: string): Promise<CryptoKey | undefined>;
}

export function remoteKeySet(url: string, fetchImpl: typeof fetch = fetch, now = Date.now): KeySet {
  let cached: { keys: Map<string, CryptoKey>; at: number } | undefined;

  async function load(): Promise<Map<string, CryptoKey>> {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Fetching ${url} failed (${response.status})`);
    const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const imported = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      imported.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, RS256, false, ["verify"]));
    }
    return imported;
  }

  return {
    async key(kid) {
      if (!cached || now() - cached.at > KEYS_TTL_MS || !cached.keys.has(kid)) {
        cached = { keys: await load(), at: now() };
      }
      return cached.keys.get(kid);
    },
  };
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  now?: () => number;
}

/** The token's claims when it is a valid RS256 JWT from `issuer` for `audience`. */
export async function verifyJwt(
  token: string,
  keys: KeySet,
  { issuer, audience, now = Date.now }: VerifyOptions,
): Promise<JwtClaims | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = decodeJson(headerPart) as typeof header;
    claims = decodeJson(payloadPart) as JwtClaims;
  } catch {
    return undefined;
  }
  if (header.alg !== "RS256" || !header.kid) return undefined;
  const key = await keys.key(header.kid);
  if (!key) return undefined;
  const valid = await crypto.subtle.verify(
    RS256,
    key,
    base64UrlDecode(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return undefined;

  const seconds = now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(audience)) return undefined;
  if (typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_S) return undefined;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + CLOCK_SKEW_S) return undefined;
  return claims;
}

/** Signs `claims` as an RS256 JWT; `kid` names the key in the header. */
export async function signJwt(claims: JwtClaims, privateKey: CryptoKey, kid?: string): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(RS256, privateKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Imports a PEM RSA private key for signing. GitHub hands out PKCS#1
 * (`BEGIN RSA PRIVATE KEY`), which WebCrypto can't read, so that form is
 * wrapped into PKCS#8 first.
 */
export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", pkcs1 ? pkcs1ToPkcs8(der) : der, RS256, false, ["sign"]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derNode(tag: number, content: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(content.length), ...content]);
}

// AlgorithmIdentifier { rsaEncryption, NULL }
const RSA_ALGORITHM = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING { pkcs1 } } */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const key = derNode(0x04, pkcs1);
  return derNode(0x30, Uint8Array.from([...version, ...RSA_ALGORITHM, ...key]));
}
