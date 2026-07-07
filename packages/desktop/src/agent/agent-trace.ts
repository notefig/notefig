import { platformAdapter } from "@/adapters";
import type { AgentDiagnosticRow } from "./agent-collections";

/**
 * Opt-in on-disk capture of a task's diagnostics stream (raw ACP frames,
 * stderr, errors, spawn context) as newline-delimited JSON at
 * `<workspace>/.metrists/agent/<taskId>.acp.jsonl`.
 *
 * Off by default: writing protocol dumps into the user's document folder is a
 * surprising side effect, so it's gated behind a dev flag. The in-memory
 * `agentDiagnosticsCollection` is always populated regardless (that powers the
 * live Raw view and AI inspection); this just makes it durable and replayable
 * when a developer opts in.
 *
 * Enable with `localStorage.setItem("metrists:agentTrace", "1")`.
 */
export function isAgentTracingEnabled(): boolean {
  return readFlag("metrists:agentTrace");
}

/**
 * Whether to expose the in-app "Raw" diagnostics view. Implied by tracing
 * (`metrists:agentTrace`) or set on its own with `metrists:agentDebug`.
 */
export function isAgentDebugEnabled(): boolean {
  return readFlag("metrists:agentDebug") || isAgentTracingEnabled();
}

function readFlag(key: string): boolean {
  try {
    return (
      typeof localStorage !== "undefined" && localStorage.getItem(key) === "1"
    );
  } catch {
    return false;
  }
}

export class AgentTracer {
  private readonly rows: AgentDiagnosticRow[] = [];
  private dirEnsured = false;
  private flushing = false;

  constructor(
    private readonly workspacePath: string,
    private readonly taskId: string,
  ) {}

  private get dir(): string {
    return `${this.workspacePath}/.metrists/agent`;
  }

  private get file(): string {
    return `${this.dir}/${this.taskId}.acp.jsonl`;
  }

  append(row: AgentDiagnosticRow): void {
    this.rows.push(row);
  }

  /** Rewrite the full jsonl (buffer is the source of truth). Best-effort. */
  async flush(): Promise<void> {
    if (this.flushing || this.rows.length === 0) return;
    this.flushing = true;
    try {
      if (!this.dirEnsured) {
        await platformAdapter.createDirectories([this.dir]);
        this.dirEnsured = true;
      }
      const content = this.rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
      await platformAdapter.writeFiles([{ path: this.file, content }]);
    } catch (error) {
      console.warn("[agent] failed to write trace file:", error);
    } finally {
      this.flushing = false;
    }
  }
}
