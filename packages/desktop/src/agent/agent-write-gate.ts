import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { FsError } from "@/adapters/platform-adapter.interface";

/**
 * The single path every agent file write takes (ACP fs/write_text_file).
 *
 * The gate's job is to make an agent edit indistinguishable from an external
 * edit: write through the platform adapter, then make sure the standard
 * content-change pipeline fires so DocumentSync's last-writer-wins arbitrates
 * against any open editor. No new merge machinery lives here or anywhere.
 */
export class AgentWriteGate {
  constructor(private readonly platformAdapter: IPlatformAdapter) {}

  async writeTextFile(path: string, content: string): Promise<void> {
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
}
