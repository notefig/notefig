import { describe, it, expect } from "vitest";
import { processOutput } from "../process-output";

const BLOCKS: Record<
  string,
  { command: string | null; running: boolean; lines: string[] }
> = {
  blob_proc_1: {
    command: "npm run dev",
    running: true,
    lines: ["a", "b", "c"],
  },
  blob_forged: { command: null, running: false, lines: [] },
};

const ctx = {
  workspacePath: "/ws",
  taskId: "task_1",
  agents: {} as never,
  services: {
    processBlocks: {
      loaded: async () => {},
      get: (blobId: string) => BLOCKS[blobId],
    },
  } as never,
};

describe("process_output", () => {
  it("reads whether the block runs and its last lines", async () => {
    expect(processOutput.requiresPermission).toBeFalsy();
    await expect(
      processOutput.execute(ctx, { blobId: "blob_proc_1", lines: 2 }),
    ).resolves.toEqual({
      ok: true,
      value: { running: true, lines: ["b", "c"] },
    });
    await expect(
      processOutput.execute(ctx, { blobId: "blob_proc_1" }),
    ).resolves.toEqual({
      ok: true,
      value: { running: true, lines: ["a", "b", "c"] },
    });
  });

  it("refuses a block the app never started", async () => {
    await expect(
      processOutput.execute(ctx, { blobId: "blob_forged" }),
    ).resolves.toEqual({ ok: false, error: "No process block blob_forged" });
  });

  it("caps how many lines one call reads", () => {
    expect(
      processOutput.input.safeParse({ blobId: "b", lines: 100_000 }).success,
    ).toBe(false);
  });
});
