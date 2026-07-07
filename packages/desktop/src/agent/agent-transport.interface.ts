/**
 * AgentTransport is the seam that keeps the ACP session layer ignorant of
 * where the agent process lives. Desktop pipes a local child process's stdio
 * (TauriStdioTransport); web tunnels the identical newline-delimited JSON-RPC
 * byte stream through the relay (RelayTransport); tests use an in-memory pair
 * (LoopbackTransport). Mirrors how worker-rpc.ts gives one typed promise API
 * over any message port.
 *
 * See docs/architecture/agent-harness.md.
 */

export type AgentTransportErrorType =
  | "spawn_failed"
  | "closed"
  | "relay_unreachable"
  | "pairing_failed"
  | "peer_disconnected"
  | "decrypt_failed"
  | "unknown";

/**
 * One error class discriminated by type, following the FsError convention.
 */
export class AgentTransportError extends Error {
  constructor(
    readonly type: AgentTransportErrorType,
    message?: string,
  ) {
    super(message ?? type.replace(/_/g, " "));
    this.name = "AgentTransportError";
  }
}

export type Unsubscribe = () => void;

/** How the child was launched — diagnostics only (no env; may hold secrets). */
export type SpawnAgentInfo = {
  pid?: number;
  /** PATH the child was given (login-shell probe on macOS, else inherited). */
  resolvedPath?: string;
  program?: string;
  args?: string[];
  cwd?: string;
};

export interface AgentTransport {
  /** Where the agent process runs relative to this UI. */
  readonly locus: "local" | "remote";

  /**
   * Bring the transport live (spawn the process / open the socket) before any
   * ACP traffic. Rejects with an AgentTransportError on spawn/connect failure.
   * Idempotent-safe to await once; in-memory transports (loopback) no-op.
   */
  start(): Promise<void>;

  /** How the process was launched; populated after start() (desktop only). */
  readonly spawnInfo?: SpawnAgentInfo;

  /** Send one JSON-RPC message (a single line, no trailing newline). */
  send(line: string): void;

  /** Subscribe to incoming JSON-RPC messages, one complete line per call. */
  onLine(callback: (line: string) => void): Unsubscribe;

  /** Fired once when the transport dies (process exit, socket loss, close). */
  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe;

  /**
   * Out-of-band diagnostic text not part of the JSON-RPC stream (adapter
   * stderr). Optional: only transports with a side channel implement it.
   */
  onDiagnostic?(callback: (line: string) => void): Unsubscribe;

  /** Tear down: kill the process / close the socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * Adapt an AgentTransport to the Writable/Readable stream pair that the
 * official ACP library's ClientSideConnection consumes.
 */
export function transportToStreams(transport: AgentTransport): {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      transport.onLine((line) => controller.enqueue(encoder.encode(line + "\n")));
      transport.onClose(() => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  let buffered = "";
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) transport.send(line);
        newline = buffered.indexOf("\n");
      }
    },
  });

  return { writable, readable };
}

/**
 * Wrap a transport so every JSON-RPC line is observed in both directions
 * before being forwarded — the tap point for the raw-frame diagnostics log.
 * Delegates all lifecycle (start/close/onDiagnostic/spawnInfo) to the inner
 * transport, so the caller can use the wrapper everywhere.
 */
export function tapTransport(
  inner: AgentTransport,
  hooks: {
    onOutgoing?: (line: string) => void;
    onIncoming?: (line: string) => void;
  },
): AgentTransport {
  return {
    locus: inner.locus,
    get spawnInfo() {
      return inner.spawnInfo;
    },
    start: () => inner.start(),
    send: (line) => {
      hooks.onOutgoing?.(line);
      inner.send(line);
    },
    onLine: (callback) =>
      inner.onLine((line) => {
        hooks.onIncoming?.(line);
        callback(line);
      }),
    onClose: (callback) => inner.onClose(callback),
    onDiagnostic: inner.onDiagnostic
      ? (callback) => inner.onDiagnostic!(callback)
      : undefined,
    close: () => inner.close(),
  };
}
