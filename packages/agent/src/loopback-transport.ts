import { subscribe } from "./agent-transport.interface";
import type { AgentTransport, Unsubscribe } from "./agent-transport.interface";
import type { AgentTransportError } from "./agent-transport.interface";

/**
 * In-memory transport pair for tests: whatever one side sends, the other
 * side's onLine subscribers receive. Fully implemented — this is the test
 * primitive the other transports are verified against.
 */
export function createLoopbackPair(): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export class LoopbackTransport implements AgentTransport {
  readonly locus = "local" as const;
  peer: LoopbackTransport | null = null;

  private lineListeners = new Set<(line: string) => void>();
  private closeListeners = new Set<(error?: AgentTransportError) => void>();
  private closed = false;

  async start(): Promise<void> {
    // In-memory pair is live on construction; nothing to spawn.
  }

  send(line: string): void {
    if (this.closed || !this.peer) return;
    for (const listener of this.peer.lineListeners) listener(line);
  }

  onLine(callback: (line: string) => void): Unsubscribe {
    return subscribe(this.lineListeners, callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    return subscribe(this.closeListeners, callback);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    if (this.peer && !this.peer.closed) await this.peer.close();
  }
}
