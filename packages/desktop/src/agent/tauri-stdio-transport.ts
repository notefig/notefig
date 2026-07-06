import type { AgentTransport, Unsubscribe } from "./agent-transport.interface";
import { AgentTransportError } from "./agent-transport.interface";

export type SpawnAgentOptions = {
  /** Unique id for this process; also namespaces the stdout/exit events. */
  procId: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

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

  constructor(private readonly options: SpawnAgentOptions) {}

  /** Spawn the process and start listening; reject on spawn failure. */
  async start(): Promise<void> {
    // TODO(phase 1): invoke spawn_agent + listen() to the namespaced events.
    throw new AgentTransportError(
      "spawn_failed",
      `not implemented: spawn ${this.options.program}`,
    );
  }

  send(_line: string): void {
    // TODO(phase 1): invoke write_agent_stdin
    throw new AgentTransportError("closed", "not implemented");
  }

  onLine(_callback: (line: string) => void): Unsubscribe {
    // TODO(phase 1)
    return () => {};
  }

  onClose(_callback: (error?: AgentTransportError) => void): Unsubscribe {
    // TODO(phase 1)
    return () => {};
  }

  async close(): Promise<void> {
    // TODO(phase 1): invoke kill_agent; idempotent
  }
}
