import { describe, it, expect } from "vitest";
import {
  createProcessBlocks,
  FLUSH_MS,
  MAX_LINE_LENGTH,
  MAX_LINES,
  type ProcessRegistry,
  type SpawnProcess,
} from "../process-blocks";

/** A spawn whose processes the test drives: lines, exit, a failed or
 *  held start. */
function fakeSpawn(
  options: { startError?: Error; startGate?: Promise<void> } = {},
) {
  const spawned: Array<{
    spec: Parameters<SpawnProcess>[0];
    emit(line: string): void;
    exit(): void;
    closed: boolean;
  }> = [];
  const spawn: SpawnProcess = (spec) => {
    const lineListeners: Array<(line: string) => void> = [];
    const closeListeners: Array<() => void> = [];
    const exit = () => closeListeners.forEach((listener) => listener());
    const process = {
      spec,
      emit: (line: string) =>
        lineListeners.forEach((listener) => listener(line)),
      exit,
      closed: false,
    };
    spawned.push(process);
    return {
      start: () =>
        options.startError
          ? Promise.reject(options.startError)
          : (options.startGate ?? Promise.resolve()),
      onLine: (listener) => (lineListeners.push(listener), () => {}),
      onClose: (listener) => (closeListeners.push(listener), () => {}),
      close: async () => {
        process.closed = true;
        exit();
      },
    };
  };
  return { spawn, spawned };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Past the batch window: emitted lines have landed. */
const flushed = () =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS + 10));
const SPEC = { command: "npm run dev", cwd: "/ws" };

/** The app's registrations: blob_proc_1 and blob_proc_2, loading until `finish`. */
function fakeRegistry() {
  let finish!: () => void;
  const load = new Promise<void>((resolve) => (finish = resolve));
  const registry: ProcessRegistry = {
    load: () => load,
    get: (blobId) =>
      ["blob_proc_1", "blob_proc_2"].includes(blobId) ? SPEC : undefined,
  };
  return { registry, finish };
}

/** A service over a loaded registry. */
async function loadedBlocks(spawn: SpawnProcess) {
  const { registry, finish } = fakeRegistry();
  const blocks = createProcessBlocks({ spawn, registry });
  finish();
  await blocks.loaded();
  return blocks;
}

describe("process blocks", () => {
  it("shows a running process's stdout", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = await loadedBlocks(spawn);

    blocks.run("blob_proc_1");
    await settle();
    spawned[0].emit("ready on :3000");
    await flushed();

    expect(spawned[0].spec).toEqual({ procId: "proc_1", ...SPEC });
    expect(blocks.get("blob_proc_1")).toEqual({
      command: "npm run dev",
      running: true,
      lines: ["ready on :3000"],
      dropped: 0,
    });
  });

  it("restarts the process once its stream is gone, not while it is live", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = await loadedBlocks(spawn);

    blocks.run("blob_proc_1");
    await settle();
    blocks.run("blob_proc_1");
    await settle();
    expect(spawned).toHaveLength(1);

    spawned[0].emit("old output");
    spawned[0].exit();
    expect(blocks.get("blob_proc_1")).toMatchObject({
      running: false,
      lines: ["old output"],
    });

    blocks.run("blob_proc_1");
    await settle();
    expect(spawned).toHaveLength(2);
    expect(blocks.get("blob_proc_1")).toMatchObject({
      running: true,
      lines: [],
    });
  });

  it("ends the run with the reason when the process can't start", async () => {
    const { spawn } = fakeSpawn({ startError: new Error("spawn failed") });
    const blocks = await loadedBlocks(spawn);

    blocks.run("blob_proc_1");
    await settle();

    expect(blocks.get("blob_proc_1")).toMatchObject({
      running: false,
      lines: ["spawn failed"],
    });
  });

  it("stops a running process, and can run it again after", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = await loadedBlocks(spawn);

    blocks.stop("blob_proc_1");
    blocks.run("blob_proc_1");
    await settle();
    spawned[0].emit("serving");
    blocks.stop("blob_proc_1");
    await settle();

    expect(spawned[0].closed).toBe(true);
    // The lines read before the stop are kept, not lost with the batch.
    expect(blocks.get("blob_proc_1")).toMatchObject({
      running: false,
      lines: ["serving"],
    });
    blocks.run("blob_proc_1");
    await settle();
    expect(spawned).toHaveLength(2);
  });

  it("holds a stop made while starting until the start is done", async () => {
    let started!: () => void;
    const { spawn, spawned } = fakeSpawn({
      startGate: new Promise((resolve) => (started = resolve)),
    });
    const blocks = await loadedBlocks(spawn);
    blocks.run("blob_proc_1");
    await settle();

    blocks.stop("blob_proc_1");
    await settle();
    expect(spawned[0].closed).toBe(false);
    started();
    await settle();
    expect(spawned[0].closed).toBe(true);
    expect(blocks.get("blob_proc_1").running).toBe(false);
  });

  it("lands a burst of lines as one change", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = await loadedBlocks(spawn);
    blocks.run("blob_proc_1");
    await settle();
    let changes = 0;
    blocks.subscribe("blob_proc_1", () => changes++);

    for (let i = 0; i < 100; i++) spawned[0].emit(String(i));
    expect(changes).toBe(0);
    await flushed();
    expect(changes).toBe(1);
    expect(blocks.get("blob_proc_1").lines).toHaveLength(100);
  });

  it("keeps each block's output apart, and only the newest lines", async () => {
    const { spawn, spawned } = fakeSpawn();
    const blocks = await loadedBlocks(spawn);
    let changes = 0;
    blocks.subscribe("blob_proc_2", () => changes++);

    blocks.run("blob_proc_1");
    await settle();
    for (let i = 0; i <= MAX_LINES; i++) spawned[0].emit(String(i));
    await flushed();
    spawned[0].emit("x".repeat(MAX_LINE_LENGTH + 1));
    await flushed();

    const { lines, dropped } = blocks.get("blob_proc_1");
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0]).toBe("2");
    expect(lines.at(-1)).toHaveLength(MAX_LINE_LENGTH);
    // What scrolled off is counted, not kept.
    expect(dropped).toBe(2);
    expect(blocks.get("blob_proc_2")).toMatchObject({
      running: false,
      lines: [],
      dropped: 0,
    });
    expect(changes).toBe(0);
  });

  it("knows no command until the registry loads, then the registered one or none", async () => {
    const { spawn, spawned } = fakeSpawn();
    const { registry, finish } = fakeRegistry();
    const blocks = createProcessBlocks({ spawn, registry });
    let changes = 0;
    blocks.subscribe("blob_proc_1", () => changes++);

    expect(blocks.get("blob_proc_1").command).toBeUndefined();
    expect(blocks.get("blob_forged").command).toBeUndefined();
    blocks.run("blob_proc_1");

    finish();
    await blocks.loaded();
    expect(changes).toBe(1);
    expect(blocks.get("blob_proc_1").command).toBe("npm run dev");
    expect(blocks.get("blob_forged").command).toBeNull();

    // An unregistered id runs nothing, and nothing ran while loading.
    blocks.run("blob_forged");
    await settle();
    expect(spawned).toHaveLength(0);
  });
});
