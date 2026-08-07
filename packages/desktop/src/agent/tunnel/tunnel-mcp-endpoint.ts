/**
 * McpEndpoint over the tunnel — the browser half of the MCP inversion. The
 * worker binds a loopback listener per task (ctl mcp-open → mcp-opened) and
 * the harness spawns the notefig CLI's hidden `mcp-relay` command against
 * it; request lines arrive here as "mcp" frames tagged {taskId, connId} and
 * every request's `respond` closes over its connId — the same
 * structurally-safe routing as the desktop TauriMcpTransport. The request
 * handler itself (mcp-server.ts) stays in the browser, unchanged.
 */
import type { McpServer } from "@notefig/shared/agent";
import {
  AgentTransportError,
  type McpEndpoint,
  type Unsubscribe,
} from "../agent-transport.interface";
import { TunnelConnection, tunnelConnection } from "./tunnel-connection";

const OPEN_TIMEOUT_MS = 15_000;

export class TunnelMcpEndpoint implements McpEndpoint {
  private readonly requestListeners = new Set<
    (line: string, respond: (line: string) => void) => void
  >();
  private readonly unsubscribers: Unsubscribe[] = [];
  private closed = false;
  private _mcpServer?: McpServer;

  constructor(
    private readonly taskId: string,
    private readonly connection: TunnelConnection = tunnelConnection,
  ) {}

  get mcpServer(): McpServer | undefined {
    return this._mcpServer;
  }

  async start(): Promise<void> {
    if (this.connection.getState().status !== "connected") {
      throw new AgentTransportError(
        "relay_unreachable",
        "not connected to a worker — pair with a machine first",
      );
    }

    // Subscribe before opening so no early request line is missed (mirrors
    // TauriMcpTransport's ordering).
    this.unsubscribers.push(
      this.connection.onMcp((taskId, connId, line) => {
        if (taskId !== this.taskId) return;
        const respond = (reply: string) => {
          if (this.closed) return;
          try {
            this.connection.sendMcp(this.taskId, connId, reply);
          } catch (error) {
            // Routine churn: that relay connection (or the tunnel) is gone.
            console.warn(
              `[mcp ${this.taskId}] reply to connection ${connId} failed:`,
              error,
            );
          }
        };
        for (const cb of this.requestListeners) cb(line, respond);
      }),
    );

    this._mcpServer = await new Promise<McpServer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new AgentTransportError("spawn_failed", "mcp-open timed out"));
      }, OPEN_TIMEOUT_MS);
      const unsubscribe = this.connection.onCtl((message) => {
        if (message.op !== "mcp-opened" || message.taskId !== this.taskId) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        // The spec's command/args/env are worker-machine paths — meaningful
        // exactly where the harness runs.
        resolve(message.mcpServer);
      });
      try {
        this.connection.sendCtl({ op: "mcp-open", taskId: this.taskId });
      } catch (error) {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      }
    });
  }

  onRequest(
    callback: (line: string, respond: (line: string) => void) => void,
  ): Unsubscribe {
    this.requestListeners.add(callback);
    return () => this.requestListeners.delete(callback);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.sendCtl({ op: "mcp-close", taskId: this.taskId });
    } catch {
      // idempotent: the worker closes listeners on task exit / disconnect
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.requestListeners.clear();
  }
}
