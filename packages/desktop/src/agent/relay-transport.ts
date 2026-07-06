import type { AgentTransport, Unsubscribe } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";

export type RelayTransportOptions = {
  /** Any server implementing packages/relay/PROTOCOL.md */
  relayUrl: string;
  /** Pairing code shown by `metrists agent` on the user's machine */
  pairingCode: string;
};

/**
 * Web transport: tunnels the ACP byte stream to the CLI worker through a
 * relay server. Frames are E2E-encrypted (XSalsa20-Poly1305, key derived
 * from the pairing code via derivePairing in @metrists/shared/relay); the
 * relay only ever sees the room id and ciphertext.
 *
 * Channels multiplexed inside the encrypted payload: "acp" (this byte
 * stream), "watch" (worker file-change events), "ctl" (worker control).
 * This class surfaces only "acp"; watch/ctl are consumed by the workspace
 * sync layer via onTunnelMessage.
 */
export class RelayTransport implements AgentTransport {
  readonly locus = "remote" as const;

  constructor(private readonly options: RelayTransportOptions) {}

  /** Connect, join the room, and complete the challenge/ack handshake. */
  async start(): Promise<void> {
    // TODO(phase 3): WebSocket + pairing derivation + challenge frame.
    throw new AgentTransportError(
      "relay_unreachable",
      `not implemented: connect ${this.options.relayUrl}`,
    );
  }

  send(_line: string): void {
    // TODO(phase 3): encrypt {ch:"acp", body:line} and send a frame
    throw new AgentTransportError("closed", "not implemented");
  }

  onLine(_callback: (line: string) => void): Unsubscribe {
    // TODO(phase 3)
    return () => {};
  }

  onClose(_callback: (error?: AgentTransportError) => void): Unsubscribe {
    // TODO(phase 3)
    return () => {};
  }

  async close(): Promise<void> {
    // TODO(phase 3)
  }
}
