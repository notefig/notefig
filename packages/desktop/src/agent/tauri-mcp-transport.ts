import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { McpServer } from "@metrists/shared/agent";
import type { AgentTransport, Unsubscribe } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";

/** Errors-as-values shape returned by the mcp_bridge.rs commands. */
type AgentResult<T = unknown> = {
  ok: boolean;
  value?: T;
  error?: { proc_id: string; type: string; message: string };
};

type McpRelayInfo = { port: number; command: string; args: string[] };

/**
 * Desktop transport for a task's MCP connection (Stage 3.5): the harness
 * spawns this app's own binary as a stdio relay (`McpServer::Stdio`), which
 * connects back to a loopback listener `mcp_bridge.rs` opened for this task.
 * Once connected, it's the exact same shape as `TauriStdioTransport` — a
 * newline-delimited JSON-RPC line channel — because it is one: `mcp_bridge.rs`
 * does no request/response bookkeeping of its own, just line-in/line-out.
 * Constructing this does nothing async — exactly like `TauriStdioTransport`,
 * the caller calls `start()` itself and reads `mcpServer` off the instance
 * afterward (this class is the only thing that knows how to express itself
 * as one).
 *
 * Rust side contract (src-tauri/src/mcp_bridge.rs):
 * - invoke("start_mcp_relay", {taskId}) / invoke("write_mcp_line", {taskId, line})
 *   / invoke("stop_mcp_relay", {taskId})
 * - events: `mcp-bridge://{taskId}/line`, `mcp-bridge://{taskId}/close`
 */
export class TauriMcpTransport implements AgentTransport {
  readonly locus = "local" as const;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(error?: AgentTransportError) => void>();
  private unlistenFns: UnlistenFn[] = [];
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private _mcpServer?: McpServer;

  constructor(private readonly taskId: string) {}

  get mcpServer(): McpServer | undefined {
    return this._mcpServer;
  }

  /** Start the listener and register handlers; reject on bind failure. */
  async start(): Promise<void> {
    // Register listeners before starting the relay so no early line is missed
    // (mirrors TauriStdioTransport's ordering).
    const line = await listen<string>(`mcp-bridge://${this.taskId}/line`, (event) => {
      for (const cb of this.lineListeners) cb(event.payload);
    });
    const close = await listen(`mcp-bridge://${this.taskId}/close`, () => {
      this.handleClose(new AgentTransportError("closed", "mcp relay connection closed"));
    });
    this.unlistenFns.push(line, close);

    let result: AgentResult<McpRelayInfo>;
    try {
      result = await invoke<AgentResult<McpRelayInfo>>("start_mcp_relay", {
        taskId: this.taskId,
      });
    } catch (error) {
      this.teardownListeners();
      throw new AgentTransportError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result.ok || !result.value) {
      this.teardownListeners();
      throw new AgentTransportError(
        "spawn_failed",
        result.error?.message ?? "failed to start mcp relay listener",
      );
    }
    const { command, args } = result.value;
    this._mcpServer = { name: "metrists", command, args, env: [] };
  }

  send(line: string): void {
    if (this.closed) {
      throw new AgentTransportError("closed", "transport is closed");
    }
    // Chain writes so concurrent send() calls stay ordered on the wire.
    this.writeChain = this.writeChain
      .then(() => invoke<AgentResult>("write_mcp_line", { taskId: this.taskId, line }))
      .then((result) => {
        if (!result.ok) {
          this.handleClose(new AgentTransportError("closed", result.error?.message));
        }
      })
      .catch((error) => {
        this.handleClose(
          new AgentTransportError(
            "closed",
            error instanceof Error ? error.message : String(error),
          ),
        );
      });
  }

  onLine(callback: (line: string) => void): Unsubscribe {
    this.lineListeners.add(callback);
    return () => this.lineListeners.delete(callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    this.closeListeners.add(callback);
    return () => this.closeListeners.delete(callback);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await invoke("stop_mcp_relay", { taskId: this.taskId });
      } catch {
        // idempotent: stopping an already-stopped listener is not an error
      }
    }
    this.handleClose();
  }

  private handleClose(error?: AgentTransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownListeners();
    for (const cb of this.closeListeners) cb(error);
  }

  private teardownListeners(): void {
    for (const unlisten of this.unlistenFns) unlisten();
    this.unlistenFns = [];
  }
}
