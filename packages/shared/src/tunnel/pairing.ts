/**
 * Pairing-code key derivation. The CLI worker generates a random 32-byte
 * secret and shows it as a pairing code (base58 secret + tunnel URL, QR, or
 * metrists://pair deep link). Both peers derive the same frame key; the
 * tunnel provider only ever carries ciphertext.
 *
 * Trust model (Happy Coder precedent): the pairing code IS the out-of-band
 * channel, so a symmetric key derived from it is equivalent to a full ECDH
 * handshake and far simpler to audit. The secret rides URL *fragments* only
 * (`https://app.notefig.com/pair#<code>`) — fragments never reach a server.
 */

import {
  base58ToBytes,
  base64UrlToBytes,
  bytesToBase58,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "./encoding";

export const PAIRING_SECRET_BYTES = 32;

const FRAME_KEY_INFO = "metrists-tunnel-frame-key-v1";
const SESSION_KEY_INFO = "metrists-tunnel-session-key-v1";

function getSubtle(): any {
  const subtle = (globalThis as Record<string, any>).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto is unavailable — the tunnel requires Node >= 20 or a modern browser",
    );
  }
  return subtle;
}

export function generatePairingSecret(): Uint8Array {
  const secret = new Uint8Array(PAIRING_SECRET_BYTES);
  (globalThis as Record<string, any>).crypto.getRandomValues(secret);
  return secret;
}

/**
 * HKDF-SHA256(secret, info="metrists-tunnel-frame-key-v1") → 32-byte
 * XSalsa20-Poly1305 frame key. Identical output on Node and browsers —
 * pinned by the fixed vectors in test-vectors.ts.
 */
export async function deriveFrameKey(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error(`pairing secret must be ${PAIRING_SECRET_BYTES} bytes`);
  }
  const subtle = getSubtle();
  const key = await subtle.importKey("raw", secret, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8Encode(FRAME_KEY_INFO),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Per-connection key: HKDF-SHA256(ikm = frameKey, salt = the connection's
 * hello.challenge, info = "metrists-tunnel-session-key-v1"). Frame counters
 * restart at 0 on every connection, so encrypting under the long-lived frame
 * key directly would reuse (key, nonce) pairs across connections — the
 * challenge is random per connection, which makes every connection's key
 * unique (and makes replayed recordings from older connections undecryptable).
 */
export async function deriveSessionKey(
  frameKey: Uint8Array,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const key = await subtle.importKey("raw", frameKey, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: challenge,
      info: utf8Encode(SESSION_KEY_INFO),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Encode a pairing secret + tunnel URL as a user-shareable code:
 * `base58(secret) + "." + base64url(url)`.
 */
export function encodePairingCode(secret: Uint8Array, url: string): string {
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error(`pairing secret must be ${PAIRING_SECRET_BYTES} bytes`);
  }
  if (!/^wss?:\/\//.test(url)) {
    throw new Error("pairing URL must be a ws:// or wss:// endpoint");
  }
  return `${bytesToBase58(secret)}.${bytesToBase64Url(utf8Encode(url))}`;
}

export function decodePairingCode(code: string): {
  secret: Uint8Array;
  url: string;
} {
  const dot = code.indexOf(".");
  if (dot <= 0 || dot === code.length - 1) {
    throw new Error("malformed pairing code");
  }
  const secret = base58ToBytes(code.slice(0, dot));
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error("malformed pairing code: bad secret length");
  }
  const url = utf8Decode(base64UrlToBytes(code.slice(dot + 1)));
  if (!/^wss?:\/\//.test(url)) {
    throw new Error("malformed pairing code: bad URL");
  }
  return { secret, url };
}

export const DEFAULT_APP_URL = "https://app.notefig.com";

/**
 * Shareable pairing links. The code lives in the fragment so it never
 * appears in any server's request log. `appBaseUrl` overrides the web app
 * origin (dev / self-host) — defaults to the hosted app.
 */
export function pairingLink(
  code: string,
  appBaseUrl: string = DEFAULT_APP_URL,
): { web: string; deepLink: string } {
  return {
    web: `${appBaseUrl.replace(/\/$/, "")}/pair#${code}`,
    deepLink: `metrists://pair#${code}`,
  };
}
