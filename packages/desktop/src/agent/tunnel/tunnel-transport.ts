/**
 * AgentTransport over the tunnel — one per task, sharing the singleton
 * connection (frames are tagged by taskId). The worker spawns the adapter
 * on ctl start-task; ACP lines ride "acp" frames both ways; stderr rides
 * ctl task-diagnostic; process death rides ctl task-exit. `locus: "remote"`
 * makes NotefigAcpClient advertise fs:false (the harness uses its own
 * native fs on the worker machine).
 */
import type { HarnessDefinition } from "@notefig/shared/agent";
import {
  AgentTransportError,
  type AgentTransport,
  type Unsubscribe,
} from "../agent-transport.interface";
import { TunnelConnection, tunnelConnection } from "./tunnel-connection";

const START_TIMEOUT_MS = 30_000;

export type TunnelTransportSpec = {
  taskId: string;
  harness: HarnessDefinition;
  workspacePath: string;
  extraEnv: Record<string, string>;
};

export class TunnelTransport implements AgentTransport {
  readonly locus = "remote" as const;

  /**
   * The agent runs on the worker, so ACP's cwd must be the worker's real
   * `--dir` (from pair-ack) — not the browser's fs-adapter workspace path.
   * The worker spawns the child there too; the two stay consistent.
   */
  get agentCwd(): string | undefined {
    return this.connection.workerInfo?.workspacePath;
  }

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<
    (error?: AgentTransportError) => void
  >();
  private readonly diagnosticListeners = new Set<(line: string) => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private closed = false;

  constructor(
    private readonly spec: TunnelTransportSpec,
    private readonly connection: TunnelConnection = tunnelConnection,
  ) {}

  async start(): Promise<void> {
    const { taskId } = this.spec;
    if (this.connection.getState().status !== "connected") {
      throw new AgentTransportError(
        "relay_unreachable",
        "not connected to a worker — pair with a machine first",
      );
    }

    this.unsubscribers.push(
      this.connection.onAcp((frameTaskId, line) => {
        if (frameTaskId !== taskId) return;
        for (const cb of this.lineListeners) cb(line);
      }),
      this.connection.onCtl((message) => {
        if (!("taskId" in message) || message.taskId !== taskId) return;
        if (message.op === "task-diagnostic") {
          for (const cb of this.diagnosticListeners) cb(message.line);
        } else if (message.op === "task-exit") {
          // Same contract as the desktop stdio transport: code 0 is clean,
          // anything else is abnormal; a close we asked for stays silent.
          this.fireClose(
            this.closed || message.code === 0
              ? undefined
              : new AgentTransportError(
                  "closed",
                  message.code === null
                    ? "agent process was killed"
                    : `agent process exited (code ${message.code})`,
                ),
          );
        }
      }),
      this.connection.onClosed((error) => this.fireClose(error)),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(
          new AgentTransportError("spawn_failed", "start-task timed out"),
        );
      }, START_TIMEOUT_MS);
      const unsubscribe = this.connection.onCtl((message) => {
        if (!("taskId" in message) || message.taskId !== taskId) return;
        if (message.op === "task-started") {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        } else if (message.op === "task-spawn-error") {
          clearTimeout(timeout);
          unsubscribe();
          reject(new AgentTransportError("spawn_failed", message.message));
        }
      });
      try {
        this.connection.sendCtl({
          op: "start-task",
          taskId,
          harnessId: this.spec.harness.id,
          cwd: this.spec.workspacePath,
          extraEnv: this.spec.extraEnv,
        });
      } catch (error) {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      }
    });
  }

  send(line: string): void {
    if (this.closed) return;
    try {
      this.connection.sendAcp(this.spec.taskId, line);
    } catch {
      // Connection gone mid-turn — onClosed handles the surfacing.
    }
  }

  onLine(callback: (line: string) => void): Unsubscribe {
    this.lineListeners.add(callback);
    return () => this.lineListeners.delete(callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    this.closeListeners.add(callback);
    return () => this.closeListeners.delete(callback);
  }

  onDiagnostic(callback: (line: string) => void): Unsubscribe {
    this.diagnosticListeners.add(callback);
    return () => this.diagnosticListeners.delete(callback);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.sendCtl({ op: "stop-task", taskId: this.spec.taskId });
    } catch {
      // best-effort: the worker kills everything on disconnect anyway
    }
    this.teardown();
  }

  private fireClose(error?: AgentTransportError): void {
    if (this.closeListeners.size === 0) return;
    const listeners = [...this.closeListeners];
    this.teardown();
    for (const cb of listeners) cb(error);
  }

  private teardown(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.lineListeners.clear();
    this.closeListeners.clear();
    this.diagnosticListeners.clear();
  }
}
