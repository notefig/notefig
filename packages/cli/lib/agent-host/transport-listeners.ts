/**
 * The listener bookkeeping every AgentTransport needs: three subscriber sets
 * and the fan-out over them. Each existing transport hand-rolls this
 * (loopback-transport.ts, tauri-stdio-transport.ts) because the interface
 * only promises `subscribe()`; composing it instead keeps the Node transport
 * to the part that is actually about child processes.
 *
 * Kept CLI-local deliberately. Hoisting it into @notefig/agent and adopting
 * it in the two existing transports is the right end state, but that is a
 * change to the desktop's transport — MET-183's territory, not this ticket's.
 */
import { subscribe, type AgentTransportError, type Unsubscribe } from '../agent';

export class TransportListeners {
  private readonly line = new Set<(line: string) => void>();
  private readonly close = new Set<(error?: AgentTransportError) => void>();
  private readonly diagnostic = new Set<(line: string) => void>();

  onLine(callback: (line: string) => void): Unsubscribe {
    return subscribe(this.line, callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    return subscribe(this.close, callback);
  }

  onDiagnostic(callback: (line: string) => void): Unsubscribe {
    return subscribe(this.diagnostic, callback);
  }

  emitLines(lines: string[]): void {
    for (const line of lines) for (const listener of this.line) listener(line);
  }

  emitDiagnostics(lines: string[]): void {
    for (const line of lines) {
      for (const listener of this.diagnostic) listener(line);
    }
  }

  /** Close fires at most once; subscribers are dropped after delivery. */
  emitClose(error?: AgentTransportError): void {
    const listeners = [...this.close];
    this.close.clear();
    for (const listener of listeners) listener(error);
  }
}
