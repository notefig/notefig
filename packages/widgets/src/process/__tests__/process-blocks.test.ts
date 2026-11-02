import { describe, it, expect } from "vitest";
import {
  createProcessBlocks,
  MAX_LINES,
  type SpawnProcess,
} from "../process-blocks";

/** A spawn whose processes the test drives: lines, exit, a failed start. */
function fakeSpawn(options: { startError?: Error } = {}) {
  const spawned: Array<{
    spec: Parameters<SpawnProcess>[0];
    emit(line: string): void;
    exit(): void;
  }> = [];
  const spawn: SpawnProcess = (spec) => {
    const lineListeners: Array<(line: string) => void> = [];
    const closeListeners: Array<() => void> = [];
    spawned.push({
      spec,
      emit: (line) => lineListeners.forEach((listener) => listener(line)),
      exit: () => closeListeners.forEach((listener) => listener()),
    });
    return {
      start: () =>
        options.startError ? Promise.reject(options.startError) : Promise.resolve(),
      onLine: (listener) => (lineListeners.push(listener), () => {}),
      onClose: (listener) => (closeListeners.push(listener), () => {}),
    };
  };
  return { spawn, spawned };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const SPEC = { command: "npm run dev", cwd: "/ws" };

describe("process blocks", () => {
  it("shows a running process's stdout", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = createProcessBlocks({ spawn });

    blocks.run("blob_1", SPEC);
    await settle();
    spawned[0].emit("ready on :3000");

    expect(spawned[0].spec).toEqual({ procId: "blob_1", ...SPEC });
    expect(blocks.get("blob_1")).toEqual({ running: true, lines: ["ready on :3000"] });
  });

  it("restarts the process once its stream is gone, not while it is live", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = createProcessBlocks({ spawn });

    blocks.run("blob_1", SPEC);
    await settle();
    blocks.run("blob_1", SPEC);
    await settle();
    expect(spawned).toHaveLength(1);

    spawned[0].emit("old output");
    spawned[0].exit();
    expect(blocks.get("blob_1")).toEqual({ running: false, lines: ["old output"] });

    blocks.run("blob_1", SPEC);
    await settle();
    expect(spawned).toHaveLength(2);
    expect(blocks.get("blob_1")).toEqual({ running: true, lines: [] });
  });

  it("ends the run with the reason when the process can't start", async () => {
    const { spawn } = fakeSpawn({ startError: new Error("spawn failed") });
    const blocks = createProcessBlocks({ spawn });

    blocks.run("blob_1", SPEC);
    await settle();

    expect(blocks.get("blob_1")).toEqual({ running: false, lines: ["spawn failed"] });
  });

  it("keeps each block's output apart, and only the newest lines", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = createProcessBlocks({ spawn });
    let changes = 0;
    blocks.subscribe("blob_2", () => changes++);

    blocks.run("blob_1", SPEC);
    await settle();
    for (let i = 0; i <= MAX_LINES; i++) spawned[0].emit(String(i));

    expect(blocks.get("blob_1").lines).toHaveLength(MAX_LINES);
    expect(blocks.get("blob_1").lines[0]).toBe("1");
    expect(blocks.get("blob_2")).toEqual({ running: false, lines: [] });
    expect(changes).toBe(0);
  });
});
