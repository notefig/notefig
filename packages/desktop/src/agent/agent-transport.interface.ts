import type { McpServer } from "@notefig/shared/agent";

/**
 * AgentTransport is the seam that keeps the ACP session layer ignorant of
 * where the agent process lives. Desktop pipes a local child process's stdio
 * (TauriStdioTransport); web tunnels the identical newline-delimited JSON-RPC
 * byte stream to a `notefig agent` worker (TunnelTransport, over the
 * encrypted tunnel — packages/shared/src/tunnel); tests use an in-memory
 * pair (LoopbackTransport). Mirrors how worker-rpc.ts gives one typed promise API
 * over any message port. The task's app-tools MCP server rides the separate
 * `McpEndpoint` seam below — it multiplexes several harness-spawned
 * connections, so it is deliberately not a line channel. Both factories
 * (`createAgentTransport`, `createMcpEndpoint`) are equally dumb: they only
 * construct, never start; the caller calls `start()` itself and reads
 * whatever platform-specific info comes back on the instance
 * (`spawnInfo`, `mcpServer`).
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
   * The working directory the agent process actually runs in, when it
   * differs from the app's workspace path. On web the app addresses files by
   * its own fs-adapter path (e.g. a File System Access synthetic path) but
   * the agent runs on a remote worker, so ACP's `cwd` must be the worker's
   * real folder — the transport is the only thing that knows it. Undefined
   * for local transports (the workspace path is already the real path).
   */
  readonly agentCwd?: string;

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
 * The app-tools MCP server's wire seam — deliberately NOT an AgentTransport.
 * ACP rides exactly one connection per task, but harnesses may run several
 * concurrent instances of the MCP server command (OpenCode spawns three), so
 * "the" connection doesn't exist here. Instead of tagging lines with
 * connection ids and trusting call sites to route replies, each request
 * carries its own `respond` — sending the reply anywhere else is
 * structurally impossible. Our MCP handler is stateless request→response
 * (no server-initiated messages), so this is the whole surface.
 */
export interface McpEndpoint {
  /** Bring the listener live; `mcpServer` is populated afterward. */
  start(): Promise<void>;

  /**
   * The ACP `McpServer` entry describing how a harness reaches this
   * endpoint (desktop: an `McpServer::Stdio` command/args). Populated after
   * `start()`; the endpoint is the only thing that knows how to express
   * itself as one.
   */
  readonly mcpServer?: McpServer;

  /**
   * Subscribe to incoming MCP request lines. `respond` writes back on the
   * connection the request arrived on.
   */
  onRequest(
    callback: (line: string, respond: (line: string) => void) => void,
  ): Unsubscribe;

  /** Tear down the listener (connected relays see their socket close). */
  close(): Promise<void>;
}

/**
 * Wire-format repair for one known ACP spec drift (MET-104): claude-agent-acp
 * emits `tool_call_update.rawOutput` as the raw Anthropic tool_result content
 * — a string or a content-block array — while the pinned
 * @zed-industries/agent-client-protocol@0.4.5 schema requires a plain object
 * (`z.record(z.unknown())`) and silently DROPS any notification that fails
 * validation. Those are exactly the frames carrying each tool call's
 * terminal status, so without this every tool shimmers until turn end. Box
 * the offending value as `{ output }` so the frame validates; nothing
 * downstream reads rawOutput structurally. (Current ACP SDKs loosened the
 * field to `unknown` — this repair dies with the dependency upgrade.)
 */
export function sanitizeAcpFrame(line: string): string {
  if (!line.includes('"rawOutput"')) return line;
  try {
    const frame = JSON.parse(line);
    const update = frame?.params?.update;
    if (
      frame?.method === "session/update" &&
      update !== null &&
      typeof update === "object" &&
      "rawOutput" in update &&
      (typeof update.rawOutput !== "object" ||
        update.rawOutput === null ||
        Array.isArray(update.rawOutput))
    ) {
      update.rawOutput = { output: update.rawOutput };
      return JSON.stringify(frame);
    }
    return line;
  } catch {
    return line;
  }
}

/**
 * Adapt an AgentTransport to the Writable/Readable stream pair that the
 * official ACP library's ClientSideConnection consumes. Incoming frames pass
 * through sanitizeAcpFrame so known adapter/schema drift never reaches the
 * library's throw-and-drop validation.
 */
export function transportToStreams(transport: AgentTransport): {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      transport.onLine((line) =>
        controller.enqueue(encoder.encode(sanitizeAcpFrame(line) + "\n")),
      );
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
