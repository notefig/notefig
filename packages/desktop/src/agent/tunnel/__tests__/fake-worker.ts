/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The worker's protocol side as an in-memory test double: an injectable
 * TunnelSocket pair plus the hello/pair/pair-ack handshake, ctl task
 * lifecycle, an in-memory fs map, and mcp-frame plumbing — built only on
 * the shared tunnel module (schemas + FrameCipher + the pinned vectors keep
 * it honest against packages/cli's real worker without importing it). ACP
 * behavior comes from the existing FakeAgent riding a loopback pair per
 * task, exactly the fixture the agent-service suites script.
 */
import {
  CtlMessageSchema,
  FrameCipher,
  TUNNEL_PROTOCOL_VERSION,
  TunnelEnvelopeSchema,
  deriveFrameKey,
  deriveSessionKey,
  generatePairingSecret,
  type CtlMessage,
  type InnerFrame,
  type WorkerInfo,
} from "@notefig/shared/tunnel";
import { bytesToBase64 } from "@notefig/shared/tunnel";
import { createLoopbackPair, type LoopbackTransport } from "../../loopback-transport";
import { FakeAgent } from "../../mock-harness";
import type { TunnelSocket, TunnelSocketFactory } from "../tunnel-connection";

type FakeTask = {
  taskId: string;
  agent: FakeAgent;
  /** The "process stdio": the client side of the loopback pair. */
  processSide: LoopbackTransport;
};

export type FakeWorkerOptions = {
  workspacePath?: string;
  workerName?: string;
  harnesses?: WorkerInfo["harnesses"];
  protocol?: number;
  /** Script each spawned task's FakeAgent (onPrompt, onLoadSession, …). */
  configureAgent?: (agent: FakeAgent, taskId: string) => void;
  /** Reject start-task for these harness ids with this message. */
  spawnError?: { harnessId: string; message: string };
};

export class FakeWorker {
  readonly secret = generatePairingSecret();
  /** Every ctl message the worker received, in order. */
  readonly receivedCtl: CtlMessage[] = [];
  readonly tasks = new Map<string, FakeTask>();

  private cipher: FrameCipher | null = null;
  private challenge = "";
  private paired = false;
  private browserSide: {
    message: ((data: string) => void)[];
    close: (() => void)[];
  } = { message: [], close: [] };
  private closed = false;
  private nextConnId = 1;

  constructor(private readonly options: FakeWorkerOptions = {}) {}

  /** Inject into TunnelConnection: the browser's side of the pair. */
  readonly socketFactory: TunnelSocketFactory = () => {
    const socket: TunnelSocket = {
      send: (data) => void this.handleFromBrowser(data),
      close: () => this.dropConnection(),
      onOpen: (cb) => queueMicrotask(cb),
      onMessage: (cb) => this.browserSide.message.push(cb),
      onClose: (cb) => this.browserSide.close.push(cb),
      onError: () => undefined,
    };
    queueMicrotask(() => void this.sendHello());
    return socket;
  };

  /** Kill the connection from the worker side (tunnel drop simulation). */
  dropConnection(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.browserSide.close) cb();
  }

  /** Simulate a task's process exiting. */
  exitTask(taskId: string, code: number | null): void {
    this.tasks.delete(taskId);
    this.sendCtl({ op: "task-exit", taskId, code });
  }

  /** Simulate adapter stderr. */
  emitDiagnostic(taskId: string, line: string): void {
    this.sendCtl({ op: "task-diagnostic", taskId, line });
  }

  /**
   * Simulate a harness-spawned MCP relay connection for a task: returns a
   * handle that sends request lines and observes response lines.
   */
  mcpConnect(taskId: string): {
    connId: number;
    send: (line: string) => void;
    received: string[];
  } {
    const connId = this.nextConnId++;
    const handle = {
      connId,
      received: [] as string[],
      send: (line: string) =>
        this.sendFrame({ ch: "mcp", taskId, connId, data: line }),
    };
    this.mcpHandles.set(`${taskId}:${connId}`, handle);
    return handle;
  }
  private readonly mcpHandles = new Map<
    string,
    { connId: number; received: string[]; send: (line: string) => void }
  >();

  private toBrowser(data: string): void {
    if (this.closed) return;
    for (const cb of this.browserSide.message) cb(data);
  }

  private async sendHello(): Promise<void> {
    const challengeBytes = crypto.getRandomValues(new Uint8Array(16));
    this.challenge = bytesToBase64(challengeBytes);
    const frameKey = await deriveFrameKey(this.secret);
    const sessionKey = await deriveSessionKey(frameKey, challengeBytes);
    this.cipher = new FrameCipher(sessionKey, "worker");
    this.toBrowser(
      JSON.stringify({
        v: TUNNEL_PROTOCOL_VERSION,
        t: "hello",
        challenge: this.challenge,
      }),
    );
  }

  private sendFrame(inner: InnerFrame): void {
    if (!this.cipher || this.closed) return;
    this.toBrowser(JSON.stringify(this.cipher.seal(inner)));
  }

  private sendCtl(message: CtlMessage): void {
    this.sendFrame({ ch: "ctl", data: message });
  }

  private async handleFromBrowser(raw: string): Promise<void> {
    if (this.closed) return;
    // The browser may send before hello's async key derivation lands.
    while (!this.cipher) await new Promise((r) => setTimeout(r, 1));
    const envelope = TunnelEnvelopeSchema.parse(JSON.parse(raw));
    if (envelope.t !== "frame") return;
    const inner = this.cipher.open(envelope);
    if (!inner) {
      this.toBrowser(
        JSON.stringify({
          v: TUNNEL_PROTOCOL_VERSION,
          t: "error",
          code: "pairing-failed",
          message: "pairing failed",
        }),
      );
      this.dropConnection();
      return;
    }
    if (!this.paired) {
      const pair =
        inner.ch === "ctl" ? CtlMessageSchema.safeParse(inner.data) : null;
      if (
        !pair?.success ||
        pair.data.op !== "pair" ||
        pair.data.challenge !== this.challenge
      ) {
        this.toBrowser(
          JSON.stringify({
            v: TUNNEL_PROTOCOL_VERSION,
            t: "error",
            code: "pairing-failed",
            message: "pairing failed",
          }),
        );
        this.dropConnection();
        return;
      }
      this.paired = true;
      this.sendCtl({
        op: "pair-ack",
        worker: {
          name: this.options.workerName ?? "fake-worker",
          workspacePath: this.options.workspacePath ?? "/remote/ws",
          harnesses: this.options.harnesses ?? [
            { id: "claude-code", available: true },
            { id: "opencode", available: true },
          ],
          protocol: this.options.protocol ?? TUNNEL_PROTOCOL_VERSION,
        },
      });
      return;
    }
    this.route(inner);
  }

  private route(inner: InnerFrame): void {
    switch (inner.ch) {
      case "acp": {
        const task = inner.taskId ? this.tasks.get(inner.taskId) : undefined;
        if (task && typeof inner.data === "string") {
          task.processSide.send(inner.data);
        }
        return;
      }
      case "mcp": {
        const handle = this.mcpHandles.get(`${inner.taskId}:${inner.connId}`);
        if (handle && typeof inner.data === "string") {
          handle.received.push(inner.data);
        }
        return;
      }
      case "ctl": {
        const message = CtlMessageSchema.parse(inner.data);
        this.receivedCtl.push(message);
        this.handleCtl(message);
        return;
      }
      default:
        return;
    }
  }

  private handleCtl(message: CtlMessage): void {
    switch (message.op) {
      case "start-task": {
        if (this.options.spawnError?.harnessId === message.harnessId) {
          this.sendCtl({
            op: "task-spawn-error",
            taskId: message.taskId,
            message: this.options.spawnError.message,
          });
          return;
        }
        const [processSide, agentSide] = createLoopbackPair();
        const agent = new FakeAgent(agentSide);
        this.options.configureAgent?.(agent, message.taskId);
        processSide.onLine((line) =>
          this.sendFrame({ ch: "acp", taskId: message.taskId, data: line }),
        );
        this.tasks.set(message.taskId, {
          taskId: message.taskId,
          agent,
          processSide,
        });
        this.sendCtl({ op: "task-started", taskId: message.taskId });
        return;
      }
      case "stop-task":
        this.tasks.delete(message.taskId);
        return;
      case "mcp-open":
        this.sendCtl({
          op: "mcp-opened",
          taskId: message.taskId,
          mcpServer: {
            name: "notefig",
            command: "/usr/bin/node",
            args: ["/worker/cli.js", "mcp-relay", "--port", "12345"],
            env: [{ name: "NOTEFIG_MCP_TOKEN", value: "fake-token" }],
          },
        });
        return;
      case "mcp-close":
        return;
      default:
        return;
    }
  }
}
