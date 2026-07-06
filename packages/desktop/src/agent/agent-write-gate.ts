import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { FsError } from "@/adapters/platform-adapter.interface";

/**
 * The single path every desktop-mediated agent write takes (ACP
 * fs/write_text_file; web mode advertises fs:false so writes there are
 * native and only adopted via the watcher).
 *
 * Two jobs:
 * 1. Make an agent edit indistinguishable from an external edit: write via
 *    the platform adapter so the standard content-change pipeline fires and
 *    DocumentSync's last-writer-wins arbitrates against open editors. No
 *    new merge machinery lives here or anywhere.
 * 2. Arbitrate parallel tasks: one gate per workspace (owned by
 *    TaskManager), writes serialized per file, every write attributed to
 *    its task so the UI can warn when two tasks touch the same path.
 */
export class AgentWriteGate {
  /** path → last task(s) that wrote it recently, for overlap warnings */
  private recentWriters = new Map<string, Set<string>>();

  constructor(private readonly platformAdapter: IPlatformAdapter) {}

  async writeTextFile(
    taskId: string,
    path: string,
    content: string,
  ): Promise<void> {
    // TODO(phase 1): serialize per-path (promise-chain keyed by path) so two
    // tasks' writes to one file never interleave; record attribution before
    // the write lands.
    this.recordWriter(taskId, path);
    const result = await this.platformAdapter.writeFiles([{ path, content }]);
    const failure = result.failed[0];
    if (failure) {
      throw new FsError(failure.type, failure.path, failure.message);
    }
    // TODO(phase 1): on platforms whose watcher won't observe our own write
    // promptly (browser adapters), synthesize the fs-content-changed event
    // here so DocumentSync adopts the agent edit without waiting for a poll.
  }

  async readTextFile(
    path: string,
    options?: { line?: number; limit?: number },
  ): Promise<string> {
    const result = await this.platformAdapter.readFiles([path]);
    const failure = result.failed[0];
    if (failure) {
      throw new FsError(failure.type, failure.path, failure.message);
    }
    const content = result.succeeded[0].content;
    if (!options?.line && !options?.limit) return content;
    // ACP lines are 1-based.
    const lines = content.split("\n");
    const start = Math.max(0, (options.line ?? 1) - 1);
    const end = options.limit ? start + options.limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  /**
   * Tasks that have written this path — the UI's overlap-warning source
   * ("two tasks are editing pricing.md").
   */
  getRecentWriters(path: string): string[] {
    return [...(this.recentWriters.get(path) ?? [])];
  }

  private recordWriter(taskId: string, path: string): void {
    const writers = this.recentWriters.get(path) ?? new Set<string>();
    writers.add(taskId);
    this.recentWriters.set(path, writers);
    // TODO(phase 1): age entries out (per-turn or time-based) so warnings
    // reflect *concurrent* interest, not all history.
  }
}
