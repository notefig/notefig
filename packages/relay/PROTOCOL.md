# Metrists Relay Protocol (v1)

A relay is a **dumb encrypted pipe**: it forwards opaque frames between the
Metrists app (browser) and a CLI worker (`metrists agent`) running on the
user's machine. The app can connect to **any** server implementing this spec
(`Settings → Relay URL`). Reference implementation: `src/server.ts` in this
package; wire schemas: `@metrists/shared/relay`.

## Design constraints

- **Zero knowledge.** The relay sees room ids and ciphertext. It never sees
  the pairing secret, frame keys, document content, prompts, or file paths.
- **No accounts.** Pairing is the only authentication.
- **Exactly two peers per room.** No fan-out, no broadcast.
- **Tiny.** One process; in-memory state only; a container or single binary.

## Transport

WebSocket. Every message is one JSON object (UTF-8), validated against the
envelope below. Anything else closes the connection (`1002`).

## Envelope

Common fields: `v` (protocol version, literal `1`), `room` (string, 16–128
chars — the room id derived from the pairing secret; see Pairing).

| `t` | Direction | Extra fields | Meaning |
| --- | --- | --- | --- |
| `hello` | peer → relay | | Join `room`. Relay replies `joined`, or `error` + close if the room already has two peers. |
| `joined` | relay → peer | | Join confirmed. |
| `peer-joined` | relay → peer | | The other side is present (sent to both once both are in). |
| `peer-left` | relay → peer | | The other side disconnected. |
| `frame` | peer ↔ relay ↔ peer | `seq` (uint), `payload` (base64, ≤ 1 MiB) | Opaque ciphertext, forwarded verbatim to the other peer. |
| `error` | relay → peer | `message` | Protocol error; connection closes. |

## Pairing and encryption (peers only — invisible to the relay)

1. The CLI worker generates a random 32-byte secret and prints a pairing
   code: base58(secret) + relay URL (also QR / `metrists://pair` deep link).
2. Both peers derive `roomId = HKDF-SHA256(secret, "room-id")` and
   `frameKey = HKDF-SHA256(secret, "frame-key")`.
3. `frame.payload` is XSalsa20-Poly1305 ciphertext under `frameKey`, nonce =
   direction byte ‖ per-direction counter (replay protection; `seq` mirrors
   the counter in cleartext for reconnect bookkeeping).
4. The first encrypted frame in each direction is a challenge/ack proving key
   possession; no application traffic before it completes.
5. Rekeying = re-pairing with a fresh secret.

Inside the decrypted payload, messages are multiplexed by channel:
`{ ch: "acp" | "watch" | "ctl", body: … }` — the ACP JSON-RPC byte stream,
file-watch events from the worker, and worker control respectively.

## Server obligations

- Validate the envelope; forward `frame` payloads verbatim; never inspect,
  persist, or log payloads.
- Enforce: max 2 peers/room, max frame size (1 MiB), room TTL on idle,
  per-IP rate limiting (token bucket).
- Notify the surviving peer with `peer-left` on any disconnect.
- Optional: a bounded replay buffer per room keyed on `seq` to smooth
  reconnects. Never persisted to disk.
