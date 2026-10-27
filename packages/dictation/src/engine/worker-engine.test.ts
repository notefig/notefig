import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerEngine } from "./worker-engine";

type Request = { id: number; method: string; args: unknown[] };
type Reply = { ok: true; result?: unknown } | { ok: false; error: string } | "crash";

/** A stand-in worker on `@notefig/worker`'s wire: says it's ready, then
 *  answers each call with `reply`, or crashes. */
class FakeWorker {
  static started: FakeWorker[] = [];
  static reply: (request: Request) => Reply = () => ({ ok: true, result: "hi" });
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  calls: Request[] = [];
  constructor() {
    FakeWorker.started.push(this);
    queueMicrotask(() => this.onmessage?.({ data: "__worker_rpc_ready__" }));
  }
  postMessage(request: Request) {
    this.calls.push(request);
    queueMicrotask(() => {
      const reply = FakeWorker.reply(request);
      if (reply === "crash") this.onerror?.({ message: "out of memory" });
      else this.onmessage?.({ data: { rpc: true, id: request.id, ...reply } });
    });
  }
  terminate() {
    this.terminated = true;
  }
}

vi.stubGlobal("Worker", FakeWorker);
afterEach(() => {
  FakeWorker.started = [];
  FakeWorker.reply = () => ({ ok: true, result: "hi" });
});

describe("createWorkerEngine", () => {
  it("loads the model once, in one worker, then transcribes", async () => {
    const engine = createWorkerEngine("https://app/dictation/");
    await engine.load();
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("hi");
    expect(FakeWorker.started).toHaveLength(1);
    expect(FakeWorker.started[0].calls.map((c) => c.method)).toEqual(["load", "transcribe"]);
    expect(FakeWorker.started[0].calls[0].args).toEqual(["https://app/dictation/"]);
  });

  it("retries a failed load on a fresh worker, and stops the old one", async () => {
    FakeWorker.reply = () => ({ ok: false, error: "chunk 3 failed its checksum" });
    const engine = createWorkerEngine("https://app/dictation/");
    await expect(engine.load()).rejects.toThrow("chunk 3 failed its checksum");
    expect(FakeWorker.started[0].terminated).toBe(true);

    FakeWorker.reply = () => ({ ok: true, result: "back" });
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("back");
    expect(FakeWorker.started).toHaveLength(2);
  });

  it("fails the call in flight when the worker dies, and replaces it", async () => {
    const engine = createWorkerEngine("https://app/dictation/");
    await engine.load();
    FakeWorker.reply = (r) => (r.method === "transcribe" ? "crash" : { ok: true });
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow("out of memory");

    FakeWorker.reply = () => ({ ok: true, result: "again" });
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("again");
    expect(FakeWorker.started).toHaveLength(2);
  });

  it("keeps the worker after a call that merely failed", async () => {
    const engine = createWorkerEngine("https://app/dictation/");
    await engine.load();
    FakeWorker.reply = () => ({ ok: false, error: "bad audio" });
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow("bad audio");

    FakeWorker.reply = () => ({ ok: true, result: "fine" });
    await expect(engine.transcribe(new Float32Array(4))).resolves.toBe("fine");
    expect(FakeWorker.started).toHaveLength(1);
  });
});
