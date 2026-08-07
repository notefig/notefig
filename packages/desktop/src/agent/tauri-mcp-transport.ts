import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MCP_SERVER_NAME, type McpServer } from "@notefig/shared/agent";
import type { McpEndpoint, Unsubscribe } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";
import { StreamPuller } from "./stream-puller";

/** Errors-as-values shape returned by the mcp_bridge.rs commands. */
type AgentResult<T = unknown> = {
  ok: boolean;
  value?: T;
  error?: { proc_id: string; type: string; message: string };
};

type McpRelayInfo = {
  port: number;
  command: string;
  args: string[];
  /** Per-task connection token; the relay presents it as its first line. */
  token: string;
};

/**
 * Desktop McpEndpoint for a task's app-tools MCP server (Stage 3.5): the
 * harness spawns this app's own binary as a stdio relay (`McpServer::Stdio`),
 * which connects back to a loopback listener `mcp_bridge.rs` opened for this
 * task. Harnesses may spawn several relay instances concurrently (OpenCode
 * spawns three — v2-opencode-config-mcp-spike.md), so each connection gets
 * its own pull stream; that multiplexing stays an internal detail here —
 * consumers get each request with a `respond` already bound to the right
 * connection. Individual relay connections coming and going is routine
 * churn, never endpoint death; the endpoint closes only via close().
 *
 * Rust side contract (src-tauri/src/mcp_bridge.rs, line_stream.rs — MET-98):
 * - invoke("start_mcp_relay", {taskId}) / invoke("write_mcp_line",
 *   {taskId, connId, line}) / invoke("stop_mcp_relay", {taskId}) /
 *   invoke("pull_stream_lines", {streamId})
 * - event: `mcp-bridge://{taskId}/doorbell` (payload `{ connId }`, no line
 *   data) — this transport drains
 *   `pull_stream_lines("mcp-bridge://{taskId}/{connId}")` per doorbell;
 *   `ended: true` means that connection closed after its tail was delivered.
 */
export class TauriMcpTransport implements McpEndpoint {
  private readonly requestListeners = new Set<
    (line: string, respond: (line: string) => void) => void
  >();
  private unlistenFns: UnlistenFn[] = [];
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private _mcpServer?: McpServer;
  private readonly pullers = new Map<number, StreamPuller>();

  constructor(private readonly taskId: string) {}

  get mcpServer(): McpServer | undefined {
    return this._mcpServer;
  }

  /** Start the listener and register handlers; reject on bind failure. */
  async start(): Promise<void> {
    // Register the doorbell listener before starting the relay so no early
    // line is missed (mirrors TauriStdioTransport's ordering).
    const doorbell = await listen<{ connId: number }>(
      `mcp-bridge://${this.taskId}/doorbell`,
      (event) => this.pullerFor(event.payload.connId).schedule(),
    );
    this.unlistenFns.push(doorbell);

    let result: AgentResult<McpRelayInfo>;
    try {
      result = await invoke<AgentResult<McpRelayInfo>>("start_mcp_relay", {
        taskId: this.taskId,
      });
    } catch (error) {
      this.teardown();
      throw new AgentTransportError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result.ok || !result.value) {
      this.teardown();
      throw new AgentTransportError(
        "spawn_failed",
        result.error?.message ?? "failed to start mcp relay listener",
      );
    }
    const { command, args, token } = result.value;
    this._mcpServer = {
      name: MCP_SERVER_NAME,
      command,
      args,
      // The harness passes this env to the relay it spawns; the relay
      // presents it as its first line and the bridge validates before wiring.
      env: [{ name: "NOTEFIG_MCP_TOKEN", value: token }],
    };
  }

  onRequest(
    callback: (line: string, respond: (line: string) => void) => void,
  ): Unsubscribe {
    this.requestListeners.add(callback);
    return () => this.requestListeners.delete(callback);
  }

  /** The pull loop for one relay connection, created on its first doorbell.
   * An ended stream (that connection closed) drops its puller — routine
   * churn, never endpoint death. */
  private pullerFor(connId: number): StreamPuller {
    let puller = this.pullers.get(connId);
    if (!puller) {
      const respond = (reply: string) => this.writeTo(connId, reply);
      puller = new StreamPuller(
        `mcp-bridge://${this.taskId}/${connId}`,
        (line) => {
          for (const cb of this.requestListeners) cb(line, respond);
        },
        () => this.pullers.delete(connId),
      );
      this.pullers.set(connId, puller);
    }
    return puller;
  }

  /**
   * Write one line back on one relay connection. Chained so concurrent
   * replies stay ordered on the wire; a failed write means that connection
   * is gone (its relay exited) — routine churn, so log and drop rather than
   * failing the endpoint.
   */
  private writeTo(connId: number, line: string): void {
    if (this.closed) return;
    this.writeChain = this.writeChain
      .then(() => invoke<AgentResult>("write_mcp_line", { taskId: this.taskId, connId, line }))
      .then((result) => {
        if (!result.ok) {
          console.warn(
            `[mcp ${this.taskId}] write to relay connection ${connId} failed:`,
            result.error?.message,
          );
        }
      })
      .catch((error) => {
        console.warn(`[mcp ${this.taskId}] write_mcp_line invoke failed:`, error);
      });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await invoke("stop_mcp_relay", { taskId: this.taskId });
    } catch {
      // idempotent: stopping an already-stopped listener is not an error
    }
    this.teardown();
  }

  private teardown(): void {
    for (const puller of this.pullers.values()) puller.stop();
    this.pullers.clear();
    for (const unlisten of this.unlistenFns) unlisten();
    this.unlistenFns = [];
  }
}
