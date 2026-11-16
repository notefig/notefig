import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentTransport,
  SpawnAgentInfo,
  Unsubscribe,
} from "@notefig/agent";
import { AgentTransportError, subscribe } from "@notefig/agent";
import { StreamPuller } from "./stream-puller";

export type SpawnAgentOptions = {
  /** Unique id for this process; also namespaces the stream/exit events. */
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

/** How long after the exit event we wait for the stdout stream's tail before
 * closing anyway — covers an orphaned grandchild holding the pipe open. */
const EXIT_DRAIN_TIMEOUT_MS = 2000;

/**
 * Desktop transport: spawns the ACP adapter as a local child process through
 * the agent_proc.rs Tauri commands and bridges its stdio.
 *
 * Rust side contract (src-tauri/src/agent_proc.rs, line_stream.rs — MET-98):
 * - invoke("spawn_agent", options) / invoke("write_agent_stdin", {procId, line})
 *   / invoke("kill_agent", {procId}) / invoke("pull_stream_lines", {streamId})
 * - stdout/stderr are PULL streams: the events
 *   `agent-proc://{procId}/stdout-doorbell` / `…/stderr-doorbell` carry no
 *   payload; on each doorbell this transport drains
 *   `pull_stream_lines("agent-proc://{procId}/stdout")` (resp. `stderr`) and
 *   fans lines out to `onLine` / `onDiagnostic`. Line payloads never ride an
 *   emit — that path amplifies bytes ~6x and a single oversized frame
 *   crashes the WebContent process.
 * - `agent-proc://{procId}/exit` reports process exit; close fires only
 *   after the stdout stream has ended (or a short drain timeout), so the
 *   tail of a turn can't be lost to an exit racing the final pulls.
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
  /** Set the moment close() is called, before its kill is answered: a spawn
   * that lands in between must still be killed (MET-288). */
  private closeRequested = false;
  private _spawnInfo?: SpawnAgentInfo;
  private stdoutPuller?: StreamPuller;
  private stderrPuller?: StreamPuller;
  private exit?: { code: number | null };
  private exitTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: SpawnAgentOptions) {}

  get spawnInfo(): SpawnAgentInfo | undefined {
    return this._spawnInfo;
  }

  /** Spawn the process and start listening; reject on spawn failure. */
  async start(): Promise<void> {
    const { procId } = this.options;

    this.stdoutPuller = new StreamPuller(
      `agent-proc://${procId}/stdout`,
      (line) => {
        for (const cb of this.lineListeners) cb(line);
      },
      // Stream ended (EOF drained): if the exit event already arrived, the
      // close was waiting on this tail.
      () => this.maybeFinishExit(),
    );
    this.stderrPuller = new StreamPuller(`agent-proc://${procId}/stderr`, (line) => {
      // Out-of-band from the JSON-RPC stream — route to diagnostics.
      for (const cb of this.diagnosticListeners) cb(line);
    });

    // Register doorbell/exit listeners before spawning so no early output is
    // missed. Doorbells carry no payload — lines travel only via pulls. Each
    // resolved unlisten is captured immediately, so if a later listen()
    // rejects, teardown() still unregisters the earlier ones (no leaked
    // callbacks for the rest of the session).
    try {
      this.unlistenFns.push(
        await listen(`agent-proc://${procId}/stdout-doorbell`, () =>
          this.stdoutPuller?.schedule(),
        ),
      );
      this.unlistenFns.push(
        await listen(`agent-proc://${procId}/stderr-doorbell`, () =>
          this.stderrPuller?.schedule(),
        ),
      );
      this.unlistenFns.push(
        await listen<{ code: number | null }>(
          `agent-proc://${procId}/exit`,
          (event) => {
            this.exit = { code: event.payload?.code ?? null };
            // The exit event races the final doorbell-driven pulls: nudge the
            // puller, close when it reports ended, and fall back to a timer in
            // case something (an orphaned grandchild) holds stdout open.
            this.stdoutPuller?.schedule();
            this.exitTimer = setTimeout(
              () => this.maybeFinishExit(true),
              EXIT_DRAIN_TIMEOUT_MS,
            );
            this.maybeFinishExit();
          },
        ),
      );
      // close() may have landed while one of the listener registrations was
      // awaiting. In that case there is no process to spawn and the late
      // listener handles must be released now.
      if (this.closeRequested) {
        this.teardown();
        return;
      }
    } catch (error) {
      this.teardown();
      throw new AgentTransportError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let result: AgentResult<SpawnResult>;
    try {
      result = await invoke<AgentResult<SpawnResult>>("spawn_agent", {
        ...this.options,
      });
    } catch (error) {
      this.teardown();
      throw new AgentTransportError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    await this.finishSpawn(result);
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
    return subscribe(this.lineListeners, callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    return subscribe(this.closeListeners, callback);
  }

  onDiagnostic(callback: (line: string) => void): Unsubscribe {
    return subscribe(this.diagnosticListeners, callback);
  }

  async close(): Promise<void> {
    if (!this.closed && !this.closeRequested) {
      this.closeRequested = true;
      await this.killProcess();
    }
    this.handleClose();
  }

  /** Validate a landed spawn and own the close-vs-registration race. */
  private async finishSpawn(result: AgentResult<SpawnResult>): Promise<void> {
    if (!result.ok) {
      this.teardown();
      throw new AgentTransportError(
        result.error?.type === "shell_env_unavailable"
          ? "shell_env_unavailable"
          : "spawn_failed",
        result.error?.message ?? "failed to spawn agent process",
      );
    }
    // close() can race the Rust spawn: its first kill sees no registered
    // process, then spawn_agent completes — possibly before that kill is
    // even answered. Kill again after registration so a task deleted during
    // startup cannot leave that late process alive.
    if (this.closed || this.closeRequested) {
      await this.killProcess();
      this.teardown();
      return;
    }
    this._spawnInfo = {
      pid: result.value?.pid,
      resolvedPath: result.value?.resolvedPath,
      program: this.options.program,
      args: this.options.args,
      cwd: this.options.cwd,
    };
  }

  private killProcess(): Promise<unknown> {
    // Idempotent: killing an unregistered or already-dead process is fine.
    return invoke("kill_agent", { procId: this.options.procId }).catch(
      () => undefined,
    );
  }

  /** Close once the exit event AND the stdout tail have both arrived. A
   * code-0 exit is clean; anything else (or a signal) becomes the onClose
   * error. If we asked to close (kill), `closed` is already set and
   * handleClose no-ops, so this only fires for spontaneous exits. */
  private maybeFinishExit(force = false): void {
    if (!this.exit || this.closed) return;
    if (!force && this.stdoutPuller && !this.stdoutPuller.ended) return;
    const code = this.exit.code;
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
  }

  private handleClose(error?: AgentTransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    for (const cb of this.closeListeners) cb(error);
  }

  private teardown(): void {
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = undefined;
    }
    this.stdoutPuller?.stop();
    this.stderrPuller?.stop();
    for (const unlisten of this.unlistenFns) unlisten();
    this.unlistenFns = [];
  }
}
