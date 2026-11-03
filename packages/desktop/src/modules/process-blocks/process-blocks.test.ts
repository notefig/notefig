/**
 * `core.processBlocks` over a real KV: a started block's command is the
 * app's, and still the app's after a relaunch; an id it never minted has none.
 */
import { describe, expect, it, vi } from "vitest";
import type { SpawnProcess } from "@notefig/widgets";
import { createNodeTestDb } from "@/testing/node-db";
import { createTestCore } from "@/testing/test-core";
import { processBlocksModule } from "./process-blocks";

function launch(db: ReturnType<typeof createNodeTestDb>) {
  const spawnProcess = vi.fn<SpawnProcess>(() => ({
    start: () => Promise.resolve(),
    onLine: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  }));
  const core = createTestCore({
    modules: [processBlocksModule],
    platform: { db, proc: { spawnProcess } } as never,
  });
  return { blocks: core.processBlocks, spawnProcess };
}

describe("process blocks module", () => {
  it("registers a started block and runs it, and knows it after a relaunch", async () => {
    const db = createNodeTestDb();
    const first = launch(db);

    const blobId = await first.blocks.start({
      command: "npm run dev",
      cwd: "/ws",
      taskId: "task_1",
    });
    // The block's id is its process's: blob_<procId>.
    const [, procId] = /^blob_(proc_[a-z0-9]+)$/.exec(blobId)!;
    await vi.waitFor(() =>
      expect(first.spawnProcess).toHaveBeenCalledWith({
        procId,
        command: "npm run dev",
        cwd: "/ws",
      }),
    );

    const after = launch(db);
    await after.blocks.loaded();
    expect(after.blocks.get(blobId).command).toBe("npm run dev");
    expect(after.blocks.get("blob_forged").command).toBeNull();
  });
});
