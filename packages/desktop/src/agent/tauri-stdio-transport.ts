import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentTransport,
  SpawnAgentInfo,
  Unsubscribe,
} from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";

export type SpawnAgentOptions = {
  /** Unique id for this process; also namespaces the stdout/exit events. */
  procId: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

/** Errors-as-values shape returned by the agent_proc.rs commands. */
type AgentResult<T = unknown> = {
  ok: boolean;
  value?: T;
  error?: { proc_id: string; type: string; message: string };
};

type SpawnResult = { pid?: number; resolvedPath?: string };

/**
 * Desktop transport: spawns the ACP adapter as a local child process through
 * the agent_proc.rs Tauri commands and bridges its stdio.
 *
 * Rust side contract (src-tauri/src/agent_proc.rs):
 * - invoke("spawn_agent", options) / invoke("write_agent_stdin", {procId, line})
 *   / invoke("kill_agent", {procId})
 * - events: `agent-proc://{procId}/stdout-line`, `…/stderr-line`, `…/exit`
 */
export class TauriStdioTransport implements AgentTransport {
  readonly locus = "local" as const;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<
    (error?: AgentTransportError) => void
  >();
  private readonly diagnosticListeners = new Set<(line: string) => void>();
  private unlistenFns: UnlistenFn[] = [];
  /** Serializes stdin writes so JSON-RPC lines reach Rust in emit order. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private _spawnInfo?: SpawnAgentInfo;

  constructor(private readonly options: SpawnAgentOptions) {}

  get spawnInfo(): SpawnAgentInfo | undefined {
    return this._spawnInfo;
  }

  /** Spawn the process and start listening; reject on spawn failure. */
  async start(): Promise<void> {
    const { procId } = this.options;

    // Register listeners before spawning so no early output is missed.
    const stdout = await listen<string>(
      `agent-proc://${procId}/stdout-line`,
      (event) => {
        for (const cb of this.lineListeners) cb(event.payload);
      },
    );
    const stderr = await listen<string>(
      `agent-proc://${procId}/stderr-line`,
      (event) => {
        // Out-of-band from the JSON-RPC stream — route to diagnostics.
        for (const cb of this.diagnosticListeners) cb(event.payload);
      },
    );
    const exit = await listen<{ code: number | null }>(
      `agent-proc://${procId}/exit`,
      (event) => {
        const code = event.payload?.code ?? null;
        // A code-0 exit is clean; anything else (or a signal) is abnormal and
        // becomes the onClose error. If we asked to close (kill), `closed` is
        // already set and handleClose no-ops, so this only fires for
        // spontaneous exits.
        const error =
          code === 0
            ? undefined
            : new AgentTransportError(
                "closed",
                code === null
                  ? "agent process was terminated (signal)"
                  : `agent process exited (code ${code})`,
              );
        this.handleClose(error);
      },
    );
    this.unlistenFns.push(stdout, stderr, exit);

    let result: AgentResult<SpawnResult>;
    try {
      result = await invoke<AgentResult<SpawnResult>>("spawn_agent", {
        ...this.options,
      });
    } catch (error) {
      this.teardownListeners();
      throw new AgentTransportError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result.ok) {
      this.teardownListeners();
      throw new AgentTransportError(
        "spawn_failed",
        result.error?.message ?? "failed to spawn agent process",
      );
    }
    this._spawnInfo = {
      pid: result.value?.pid,
      resolvedPath: result.value?.resolvedPath,
      program: this.options.program,
      args: this.options.args,
      cwd: this.options.cwd,
    };
  }

  send(line: string): void {
    if (this.closed) {
      throw new AgentTransportError("closed", "transport is closed");
    }
    // Chain writes so concurrent send() calls stay ordered on the wire.
    this.writeChain = this.writeChain
      .then(() =>
        invoke<AgentResult>("write_agent_stdin", {
          procId: this.options.procId,
          line,
        }),
      )
      .then((result) => {
        if (!result.ok) {
          this.handleClose(
            new AgentTransportError("closed", result.error?.message),
          );
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

  onDiagnostic(callback: (line: string) => void): Unsubscribe {
    this.diagnosticListeners.add(callback);
    return () => this.diagnosticListeners.delete(callback);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await invoke("kill_agent", { procId: this.options.procId });
      } catch {
        // idempotent: killing an already-dead process is not an error
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
