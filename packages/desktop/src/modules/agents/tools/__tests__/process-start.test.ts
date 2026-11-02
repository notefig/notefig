import { describe, it, expect, vi } from "vitest";
import { processStart } from "../process-start";

describe("process_start", () => {
  it("starts the block in the workspace and hands back its marker", async () => {
    const start = vi.fn(async () => "blob_new1");
    const ctx = {
      workspacePath: "/ws",
      taskId: "task_1",
      agents: {} as never,
      services: { processBlocks: { start } } as never,
    };

    expect(processStart.requiresPermission).toBe(true);
    expect(processStart.input.safeParse({ command: "" }).success).toBe(false);
    await expect(
      processStart.execute(ctx, { command: "npm run dev" }),
    ).resolves.toEqual({
      ok: true,
      value: {
        blobId: "blob_new1",
        marker: '<!-- notefig:process id="blob_new1" -->',
      },
    });
    expect(start).toHaveBeenCalledWith({
      command: "npm run dev",
      cwd: "/ws",
      taskId: "task_1",
    });
  });
});
