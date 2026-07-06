/**
 * Pairing-code key derivation. The CLI worker generates a random 32-byte
 * secret and shows it as a pairing code (base58 + relay URL, QR, or
 * metrists://pair deep link). Both peers derive the same room id and frame
 * key; the relay only ever sees the room id.
 *
 * Trust model (Happy Coder precedent): the pairing code IS the out-of-band
 * channel, so a symmetric key derived from it is equivalent to a full ECDH
 * handshake and far simpler to audit.
 */

export type PairingKeys = {
  /** HKDF(secret, "room-id") — safe to reveal to the relay */
  roomId: string;
  /** HKDF(secret, "frame-key") — XSalsa20-Poly1305 key, never leaves peers */
  frameKey: Uint8Array;
};

export const PAIRING_SECRET_BYTES = 32;

/**
 * Derive room id and frame key from a pairing secret.
 */
export function derivePairing(_secret: Uint8Array): PairingKeys {
  // TODO(phase 3): HKDF-SHA256 with the two info strings above.
  throw new Error("not implemented: derivePairing");
}

/**
 * Encode a pairing secret + relay URL as a user-shareable code, and back.
 */
export function encodePairingCode(
  _secret: Uint8Array,
  _relayUrl: string,
): string {
  // TODO(phase 3): base58 secret + URL, also embeddable in metrists://pair
  throw new Error("not implemented: encodePairingCode");
}

export function decodePairingCode(_code: string): {
  secret: Uint8Array;
  relayUrl: string;
} {
  // TODO(phase 3)
  throw new Error("not implemented: decodePairingCode");
}
