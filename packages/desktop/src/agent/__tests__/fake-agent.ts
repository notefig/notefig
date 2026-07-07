import type { LoopbackTransport } from "../loopback-transport";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * A scripted ACP agent for tests: sits on the agent side of a LoopbackTransport
 * pair and answers the real client (ClientSideConnection driven by AgentTask).
 * Replaces a fake adapter process — assertions snapshot the client side.
 */
export class FakeAgent {
  private nextId = 1;
  private pendingClientRequests = new Map<number, (result: Json) => void>();

  initializeResult: Json = {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
  };
  newSessionResult: Json = { sessionId: "sess_test" };
  /** Scripted turn behavior; may emit updates / request permission via `this`. */
  onPrompt: (params: Json, agent: FakeAgent) => Promise<{ stopReason: string }> =
    async () => ({ stopReason: "end_turn" });

  constructor(private readonly transport: LoopbackTransport) {
    transport.onLine((line) => void this.handle(JSON.parse(line)));
  }

  private sendRaw(obj: Json): void {
    this.transport.send(JSON.stringify(obj));
  }

  respond(id: number, result: Json): void {
    this.sendRaw({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method: string, params: Json): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  /** Emit a session/update notification to the client. */
  update(sessionId: string, update: Json): void {
    this.notify("session/update", { sessionId, update });
  }

  /** Send a request to the client (fs/*, request_permission) and await its reply. */
  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingClientRequests.set(id, resolve);
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async handle(msg: Json): Promise<void> {
    // A response to one of our client-directed requests (no method field).
    if (msg.method === undefined && msg.id !== undefined) {
      const cb = this.pendingClientRequests.get(msg.id);
      if (cb) {
        this.pendingClientRequests.delete(msg.id);
        cb(msg.result);
      }
      return;
    }

    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return this.respond(id, this.initializeResult);
      case "session/new":
        return this.respond(id, this.newSessionResult);
      case "session/prompt": {
        try {
          const result = await this.onPrompt(params, this);
          this.respond(id, result);
        } catch (error) {
          this.respondError(
            id,
            -32000,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      case "session/cancel":
        return; // notification, no response
      default:
        if (id !== undefined) this.respondError(id, -32601, "not implemented");
    }
  }
}
