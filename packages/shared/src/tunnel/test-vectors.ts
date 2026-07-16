/**
 * Fixed vectors for the tunnel crypto. Both runtimes' test suites — the CLI
 * worker (jest/Node) and the web app (vitest/happy-dom) — assert against
 * these same values; that is the cross-runtime symmetry proof, and it is
 * what keeps each package's protocol test double honest without importing
 * the other's code. Regenerate only on a deliberate protocol version bump.
 */
import type { InnerFrame } from "./tunnel-protocol";

/** 32-byte pairing secret, hex. */
export const VECTOR_SECRET_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** HKDF-SHA256(secret, info="metrists-tunnel-frame-key-v1"), hex. */
export const VECTOR_FRAME_KEY_HEX =
  "e25236c5beeba706c6af8d70bfc555c7e51b451f23acb6030a7ffd2a68b3c5c8";

/** A fixed hello.challenge (16 bytes, hex) for session-key derivation. */
export const VECTOR_CHALLENGE_HEX = "101112131415161718191a1b1c1d1e1f";

/** HKDF-SHA256(frameKey, salt=challenge, info="metrists-tunnel-session-key-v1"). */
export const VECTOR_SESSION_KEY_HEX =
  "f7ac8048e44ad4ce28998ce268dcbdeb2a86ae716300ef297cd4fdc9c661e375";

/** A representative inner frame; key order matters for the ciphertext. */
export const VECTOR_INNER_FRAME: InnerFrame = {
  ch: "acp",
  taskId: "task-1",
  data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
};

/**
 * seal(VECTOR_INNER_FRAME) under the SESSION key as browser at seq 0 →
 * envelope payload, base64. (Frames are always sealed under a session key,
 * never the frame key directly.)
 */
export const VECTOR_BROWSER_SEQ0_PAYLOAD_B64 =
  "OpOeYTnZwZX/ZZIGKHjpbwqnfp5B7xdsbafYXbQQxPNg2aFdT1m3al5Iiin8yielZtJ5U9YmNqywxUemrr/1S0tmaQzmOlTaLcnUCBsZyvDiTJ9DI3qeidDKl2g7Dk1onoM/4jNw1EzVRRm0W/0n5g==";

/** seal(VECTOR_INNER_FRAME) under the SESSION key as worker at seq 0. */
export const VECTOR_WORKER_SEQ0_PAYLOAD_B64 =
  "vNs2PnbC+Q9a9Rf5dpovIWQ1vjttzcD3B8Ryfs+CaqVps5APMM+K3LGp85dA+C18EonavEpcaqpLAMvgZJ/u2AK06bFXYB90NwX8F3IoHjdPdZuLLOHNUOw9YuNc65FqAdVyoWbd7UG0nXO7eQ+5xg==";

/** Pairing code for VECTOR_SECRET_HEX + this URL. */
export const VECTOR_TUNNEL_URL = "wss://example.trycloudflare.com";
export const VECTOR_PAIRING_CODE =
  "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE.d3NzOi8vZXhhbXBsZS50cnljbG91ZGZsYXJlLmNvbQ";
