/**
 * Worker side of the relay tunnel: WebSocket to the relay, pairing-code
 * generation, frame encryption/decryption, and channel demultiplexing
 * ({ ch: "acp" | "watch" | "ctl" }). Counterpart of the app's
 * relay-transport.ts; wire schemas come from @metrists/shared/relay.
 */
import type { TunnelMessage } from '@metrists/shared';

export type RelayConnectionOptions = {
  relayUrl: string;
};

export class RelayConnection {
  constructor(private readonly options: RelayConnectionOptions) {}

  /**
   * Generate a pairing secret, join the derived room, and return the
   * pairing code to print for the user.
   */
  async pair(): Promise<{ pairingCode: string }> {
    // TODO(phase 3): derivePairing + encodePairingCode from
    // @metrists/shared (relay), ws connect, hello/joined.
    throw new Error(`not implemented: pair with ${this.options.relayUrl}`);
  }

  /** Resolves when the browser peer has joined and passed challenge/ack. */
  async waitForPeer(): Promise<void> {
    throw new Error('not implemented: waitForPeer');
  }

  send(_message: TunnelMessage): void {
    throw new Error('not implemented: send');
  }

  onMessage(_callback: (message: TunnelMessage) => void): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    // TODO(phase 3)
  }
}
