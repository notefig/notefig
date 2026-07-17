/**
 * The browser's one connection to a `metrists agent` worker: WebSocket +
 * pairing handshake + encrypted frame mux/demux, exposed as typed
 * per-channel sub-surfaces (acp / mcp / ctl). Files never cross the tunnel —
 * the browser's own fs adapter owns them. Module-level singleton
 * (`tunnelConnection`) — one pairing = one peer in v1.
 *
 * Lifecycle contract: on socket loss the async `onDisconnect` pipeline runs
 * FIRST (task disposal, so demoted rows survive), then the sync `onClosed`
 * listeners fire (transports surface peer_disconnected).
 * Protocol: packages/shared/src/tunnel/PROTOCOL.md.
 */
import {
  CtlMessageSchema,
  FrameCipher,
  InnerFrameSchema,
  TUNNEL_PROTOCOL_VERSION,
  TunnelEnvelopeSchema,
  deriveFrameKey,
  deriveSessionKey,
  type CtlMessage,
  type InnerFrame,
  type WorkerInfo,
} from "@metrists/shared/tunnel";
import { base64ToBytes } from "@metrists/shared/tunnel";
import type { z } from "zod";
import {
  AgentTransportError,
  type Unsubscribe,
} from "../agent-transport.interface";

const HANDSHAKE_TIMEOUT_MS = 15_000;

/** The minimal socket surface — injectable so tests run an in-memory pair. */
export interface TunnelSocket {
  send(data: string): void;
  close(): void;
  onOpen(callback: () => void): void;
  onMessage(callback: (data: string) => void): void;
  onClose(callback: () => void): void;
  onError(callback: (error: unknown) => void): void;
}

export type TunnelSocketFactory = (url: string) => TunnelSocket;

const webSocketFactory: TunnelSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (cb) => socket.addEventListener("open", cb),
    onMessage: (cb) =>
      socket.addEventListener("message", (event) => cb(String(event.data))),
    onClose: (cb) => socket.addEventListener("close", cb),
    onError: (cb) => socket.addEventListener("error", cb),
  };
};

export type TunnelPairing = { secret: Uint8Array; url: string };

export type TunnelConnectionState =
  | { status: "disconnected"; error?: string }
  | { status: "connecting" }
  | { status: "connected"; workerInfo: WorkerInfo };

export class TunnelConnection {
  private socket: TunnelSocket | null = null;
  private cipher: FrameCipher | null = null;
  private state: TunnelConnectionState = { status: "disconnected" };

  private readonly stateListeners = new Set<() => void>();
  private readonly acpListeners = new Set<
    (taskId: string, line: string) => void
  >();
  private readonly mcpListeners = new Set<
    (taskId: string, connId: number, line: string) => void
  >();
  private readonly ctlListeners = new Set<(message: CtlMessage) => void>();
  /** Async pipeline run FIRST on socket loss (task disposal — Part 5). */
  private readonly disconnectHandlers = new Set<() => Promise<void>>();
  /** Sync listeners run after the disconnect pipeline (transport onClose). */
  private readonly closedListeners = new Set<
    (error: AgentTransportError) => void
  >();

  constructor(private readonly socketFactory: TunnelSocketFactory = webSocketFactory) {}

  // ========== state ==========

  getState(): TunnelConnectionState {
    return this.state;
  }

  get workerInfo(): WorkerInfo | null {
    return this.state.status === "connected" ? this.state.workerInfo : null;
  }

  /** useSyncExternalStore-compatible subscription. */
  subscribe(listener: () => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: TunnelConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener();
  }

  // ========== connect / disconnect ==========

  async connect(pairing: TunnelPairing): Promise<WorkerInfo> {
    if (this.state.status !== "disconnected") {
      throw new AgentTransportError(
        "unknown",
        "tunnel is already connected or connecting",
      );
    }
    this.setState({ status: "connecting" });

    try {
      const workerInfo = await this.handshake(pairing);
      this.setState({ status: "connected", workerInfo });
      return workerInfo;
    } catch (error) {
      this.socket?.close();
      this.socket = null;
      this.cipher = null;
      this.setState({
        status: "disconnected",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  disconnect(): void {
    this.socket?.close();
  }

  private handshake(pairing: TunnelPairing): Promise<WorkerInfo> {
    return new Promise<WorkerInfo>((resolve, reject) => {
      const socket = this.socketFactory(pairing.url);
      this.socket = socket;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(
        () =>
          fail(
            new AgentTransportError("relay_unreachable", "handshake timed out"),
          ),
        HANDSHAKE_TIMEOUT_MS,
      );

      socket.onError(() =>
        fail(
          new AgentTransportError(
            "relay_unreachable",
            "could not reach the worker — is `metrists agent` still running?",
          ),
        ),
      );
      socket.onClose(() => {
        if (!settled) {
          fail(
            new AgentTransportError("peer_disconnected", "socket closed during handshake"),
          );
          return;
        }
        void this.handleSocketClosed();
      });

      socket.onMessage((raw) => {
        void (async () => {
          let envelope: z.infer<typeof TunnelEnvelopeSchema>;
          try {
            envelope = TunnelEnvelopeSchema.parse(JSON.parse(raw));
          } catch {
            // A version-mismatched hello also lands here (v is a literal).
            fail(
              new AgentTransportError(
                "unknown",
                "protocol mismatch — update the metrists CLI and the app to matching versions",
              ),
            );
            this.socket?.close();
            return;
          }
          if (envelope.t === "error") {
            const type =
              envelope.code === "pairing-failed"
                ? "pairing_failed"
                : envelope.code === "busy"
                  ? "relay_unreachable"
                  : "unknown";
            fail(new AgentTransportError(type, envelope.message));
            return;
          }
          if (envelope.t === "hello") {
            if (this.cipher) return; // duplicate hello — ignore
            const frameKey = await deriveFrameKey(pairing.secret);
            const sessionKey = await deriveSessionKey(
              frameKey,
              base64ToBytes(envelope.challenge),
            );
            this.cipher = new FrameCipher(sessionKey, "browser");
            this.sendFrame({
              ch: "ctl",
              data: { op: "pair", challenge: envelope.challenge },
            });
            return;
          }
          // frame
          const inner = this.cipher?.open(envelope);
          if (!inner) {
            fail(new AgentTransportError("decrypt_failed", "bad frame"));
            this.socket?.close();
            return;
          }
          if (!settled) {
            // The first decrypted frame must be pair-ack.
            const ack =
              inner.ch === "ctl" ? CtlMessageSchema.safeParse(inner.data) : null;
            if (!ack?.success || ack.data.op !== "pair-ack") {
              fail(new AgentTransportError("pairing_failed", "no pair-ack"));
              this.socket?.close();
              return;
            }
            if (ack.data.worker.protocol !== TUNNEL_PROTOCOL_VERSION) {
              fail(
                new AgentTransportError(
                  "unknown",
                  "protocol mismatch — update the metrists CLI and the app to matching versions",
                ),
              );
              this.socket?.close();
              return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(ack.data.worker);
            return;
          }
          this.dispatch(inner);
        })();
      });
    });
  }

  private async handleSocketClosed(): Promise<void> {
    if (this.state.status === "disconnected") return;
    this.socket = null;
    this.cipher = null;

    const error = new AgentTransportError(
      "peer_disconnected",
      "the worker connection dropped",
    );

    // Disposal pipeline first (demotes tasks to "restored"), then transport
    // close listeners (their AgentTasks are already disposed → guarded).
    for (const handler of this.disconnectHandlers) {
      try {
        await handler();
      } catch (handlerError) {
        console.warn("[tunnel] disconnect handler failed:", handlerError);
      }
    }
    this.setState({ status: "disconnected", error: error.message });
    for (const listener of this.closedListeners) listener(error);
  }

  // ========== frame IO ==========

  private sendFrame(inner: InnerFrame): void {
    if (!this.socket || !this.cipher) {
      throw new AgentTransportError("relay_unreachable", "tunnel is not connected");
    }
    this.socket.send(JSON.stringify(this.cipher.seal(inner)));
  }

  private dispatch(inner: InnerFrame): void {
    switch (inner.ch) {
      case "acp":
        if (inner.taskId && typeof inner.data === "string") {
          for (const cb of this.acpListeners) cb(inner.taskId, inner.data);
        }
        return;
      case "mcp":
        if (
          inner.taskId &&
          typeof inner.connId === "number" &&
          typeof inner.data === "string"
        ) {
          for (const cb of this.mcpListeners) {
            cb(inner.taskId, inner.connId, inner.data);
          }
        }
        return;
      case "ctl": {
        const parsed = CtlMessageSchema.safeParse(inner.data);
        if (parsed.success) {
          for (const cb of this.ctlListeners) cb(parsed.data);
        }
        return;
      }
    }
  }

  // ========== typed channel surfaces ==========

  sendAcp(taskId: string, line: string): void {
    this.sendFrame({ ch: "acp", taskId, data: line });
  }

  onAcp(callback: (taskId: string, line: string) => void): Unsubscribe {
    this.acpListeners.add(callback);
    return () => this.acpListeners.delete(callback);
  }

  sendMcp(taskId: string, connId: number, line: string): void {
    this.sendFrame({ ch: "mcp", taskId, connId, data: line });
  }

  onMcp(
    callback: (taskId: string, connId: number, line: string) => void,
  ): Unsubscribe {
    this.mcpListeners.add(callback);
    return () => this.mcpListeners.delete(callback);
  }

  sendCtl(message: CtlMessage): void {
    this.sendFrame({ ch: "ctl", data: message });
  }

  onCtl(callback: (message: CtlMessage) => void): Unsubscribe {
    this.ctlListeners.add(callback);
    return () => this.ctlListeners.delete(callback);
  }

  /** Part 5 lifecycle: async work that must finish before onClosed fires. */
  onDisconnect(handler: () => Promise<void>): Unsubscribe {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  /** Transport-level notification, after the disconnect pipeline. */
  onClosed(callback: (error: AgentTransportError) => void): Unsubscribe {
    this.closedListeners.add(callback);
    return () => this.closedListeners.delete(callback);
  }

  /** InnerFrameSchema re-exported for test doubles. */
  static readonly innerFrameSchema = InnerFrameSchema;
}

/** The app-wide singleton — one pairing = one peer in v1. */
export const tunnelConnection = new TunnelConnection();
