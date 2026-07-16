import {
  decodePairingCode,
  encodePairingCode,
  generatePairingSecret,
  pairingLink,
  PAIRING_SECRET_BYTES,
} from "./pairing";
import { VECTOR_PAIRING_CODE, VECTOR_SECRET_HEX, VECTOR_TUNNEL_URL } from "./test-vectors";

const hexToBytes = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

describe("pairing codes", () => {
  it("encodes the pinned secret + URL to the pinned code", () => {
    expect(
      encodePairingCode(hexToBytes(VECTOR_SECRET_HEX), VECTOR_TUNNEL_URL),
    ).toBe(VECTOR_PAIRING_CODE);
  });

  it("round-trips, including URLs with port and path", () => {
    const secret = generatePairingSecret();
    expect(secret).toHaveLength(PAIRING_SECRET_BYTES);
    for (const url of [
      "wss://abc-def.trycloudflare.com",
      "ws://127.0.0.1:8443/tunnel?x=1",
    ]) {
      const decoded = decodePairingCode(encodePairingCode(secret, url));
      expect(decoded.url).toBe(url);
      expect(Buffer.from(decoded.secret)).toEqual(Buffer.from(secret));
    }
  });

  it("rejects malformed codes", () => {
    expect(() => decodePairingCode("")).toThrow();
    expect(() => decodePairingCode("nodothere")).toThrow();
    expect(() => decodePairingCode("abc.")).toThrow();
    // valid shape but truncated secret
    expect(() => decodePairingCode("1thX6.d3NzOi8vYQ")).toThrow();
    // 0/O/I/l are not base58
    expect(() =>
      decodePairingCode(`O0Il${VECTOR_PAIRING_CODE.slice(4)}`),
    ).toThrow();
  });

  it("rejects non-websocket URLs at encode time", () => {
    expect(() =>
      encodePairingCode(generatePairingSecret(), "https://example.com"),
    ).toThrow();
  });

  it("builds fragment-carried links", () => {
    const links = pairingLink("CODE");
    expect(links.web).toBe("https://app.metrists.com/pair#CODE");
    expect(links.deepLink).toBe("metrists://pair#CODE");
  });
});
