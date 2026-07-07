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
  /** How long a task's write keeps it in the "recent writers" of a path. */
  private static readonly OVERLAP_WINDOW_MS = 30_000;

  /** path → task → last write time (ms), for overlap warnings. */
  private recentWriters = new Map<string, Map<string, number>>();

  /** path → tail of the in-flight write chain, so writes never interleave. */
  private writeChains = new Map<string, Promise<void>>();

  constructor(private readonly platformAdapter: IPlatformAdapter) {}

  async writeTextFile(
    taskId: string,
    path: string,
    content: string,
  ): Promise<void> {
    // Serialize per path: two tasks writing the same file queue instead of
    // interleaving. The stored chain swallows errors so one failed write
    // doesn't poison later ones; the returned promise still rejects.
    const previous = this.writeChains.get(path) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        this.recordWriter(taskId, path);
        const result = await this.platformAdapter.writeFiles([{ path, content }]);
        const failure = result.failed[0];
        if (failure) {
          throw new FsError(failure.type, failure.path, failure.message);
        }
        // On desktop the OS watcher observes this write and drives the standard
        // fs-content-changed → DocumentSync adoption path (same as any external
        // edit). Web mode advertises fs:false, so no agent write reaches here.
      });
    this.writeChains.set(
      path,
      run.catch(() => {}),
    );
    return run;
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
   * Tasks that wrote this path within the overlap window — the UI's
   * overlap-warning source ("two tasks are editing pricing.md"). Ages out
   * stale entries so warnings reflect *concurrent* interest, not all history.
   */
  getRecentWriters(path: string): string[] {
    const writers = this.recentWriters.get(path);
    if (!writers) return [];
    const cutoff = Date.now() - AgentWriteGate.OVERLAP_WINDOW_MS;
    const active: string[] = [];
    for (const [taskId, writtenAt] of writers) {
      if (writtenAt >= cutoff) active.push(taskId);
      else writers.delete(taskId);
    }
    if (writers.size === 0) this.recentWriters.delete(path);
    return active;
  }

  /**
   * Paths currently claimed by more than one task within the overlap window —
   * the UI banner source ("two tasks are editing pricing.md").
   */
  getOverlappingPaths(): { path: string; taskIds: string[] }[] {
    const overlaps: { path: string; taskIds: string[] }[] = [];
    for (const path of [...this.recentWriters.keys()]) {
      const taskIds = this.getRecentWriters(path);
      if (taskIds.length > 1) overlaps.push({ path, taskIds });
    }
    return overlaps;
  }

  private recordWriter(taskId: string, path: string): void {
    const writers = this.recentWriters.get(path) ?? new Map<string, number>();
    writers.set(taskId, Date.now());
    this.recentWriters.set(path, writers);
  }
}
