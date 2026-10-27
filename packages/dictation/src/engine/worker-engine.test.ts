import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { createWorkerEngine } from "./worker-engine";

/** A stand-in worker: answers each request with `reply`, or crashes. */
class FakeWorker {
  static started: FakeWorker[] = [];
  static reply: (request: WorkerRequest) => WorkerResponse | "crash" = (r) => ({ id: r.id, ok: true, text: "hi" });
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  terminated = false;
  requests: WorkerRequest[] = [];
  constructor() {
    FakeWorker.started.push(this);
  }
  postMessage(request: WorkerRequest) {
    this.requests.push(request);
    queueMicrotask(() => {
      const reply = FakeWorker.reply(request);
      if (reply === "crash") this.onerror?.({ message: "out of memory", preventDefault() {} });
      else this.onmessage?.({ data: reply });
    });
  }
  terminate() {
    this.terminated = true;
  }
}

vi.stubGlobal("Worker", FakeWorker);
afterEach(() => {
  FakeWorker.started = [];
  FakeWorker.reply = (r) => ({ id: r.id, ok: true, text: "hi" });
});

describe("createWorkerEngine", () => {
  it("loads the model once, in one worker, then transcribes", async () => {
    const engine = createWorkerEngine("https://app/dictation/");
    await engine.load();
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("hi");
    expect(FakeWorker.started).toHaveLength(1);
    expect(FakeWorker.started[0].requests.map((r) => r.method)).toEqual(["load", "transcribe"]);
    expect(FakeWorker.started[0].requests[0]).toMatchObject({ modelUrl: "https://app/dictation/" });
  });

  it("retries a failed load on a fresh worker, and stops the old one", async () => {
    FakeWorker.reply = (r) => ({ id: r.id, ok: false, error: "chunk 3 failed its checksum" });
    const engine = createWorkerEngine("https://app/dictation/");
    await expect(engine.load()).rejects.toThrow("chunk 3 failed its checksum");
    expect(FakeWorker.started[0].terminated).toBe(true);

    FakeWorker.reply = (r) => ({ id: r.id, ok: true, text: "back" });
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("back");
    expect(FakeWorker.started).toHaveLength(2);
  });

  it("fails the call in flight when the worker dies, and replaces it", async () => {
    const engine = createWorkerEngine("https://app/dictation/");
    await engine.load();
    FakeWorker.reply = (r) => (r.method === "transcribe" ? "crash" : { id: r.id, ok: true });
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow("out of memory");
    expect(FakeWorker.started[0].terminated).toBe(true);

    FakeWorker.reply = (r) => ({ id: r.id, ok: true, text: "again" });
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("again");
    expect(FakeWorker.started).toHaveLength(2);
  });
});
