/**
 * Cross-runtime symmetry proof, browser-side half: the same pinned vectors
 * the shared (jest/Node) and CLI suites assert must reproduce under the
 * desktop test runtime. If this diverges from packages/shared's own vector
 * test, the two peers cannot talk.
 */
import { describe, expect, it } from "vitest";
import {
  FrameCipher,
  deriveFrameKey,
  deriveSessionKey,
  VECTOR_BROWSER_SEQ0_PAYLOAD_B64,
  VECTOR_CHALLENGE_HEX,
  VECTOR_FRAME_KEY_HEX,
  VECTOR_INNER_FRAME,
  VECTOR_SECRET_HEX,
  VECTOR_SESSION_KEY_HEX,
  VECTOR_WORKER_SEQ0_PAYLOAD_B64,
} from "@metrists/shared/tunnel";

const hexToBytes = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const bytesToHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("tunnel fixed vectors (desktop runtime)", () => {
  it("derives the pinned frame and session keys", async () => {
    const frameKey = await deriveFrameKey(hexToBytes(VECTOR_SECRET_HEX));
    expect(bytesToHex(frameKey)).toBe(VECTOR_FRAME_KEY_HEX);
    const sessionKey = await deriveSessionKey(
      frameKey,
      hexToBytes(VECTOR_CHALLENGE_HEX),
    );
    expect(bytesToHex(sessionKey)).toBe(VECTOR_SESSION_KEY_HEX);
  });

  it("seals the pinned inner frame to the pinned ciphertexts", () => {
    const key = hexToBytes(VECTOR_SESSION_KEY_HEX);
    expect(new FrameCipher(key, "browser").seal(VECTOR_INNER_FRAME).payload).toBe(
      VECTOR_BROWSER_SEQ0_PAYLOAD_B64,
    );
    expect(new FrameCipher(key, "worker").seal(VECTOR_INNER_FRAME).payload).toBe(
      VECTOR_WORKER_SEQ0_PAYLOAD_B64,
    );
  });
});
