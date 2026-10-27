/**
 * Dictation worker: runs the bundled speech model off the main thread.
 * onnxruntime-web on one WebAssembly thread — the app isn't cross-origin
 * isolated (that would break remote images in notes), and one thread decodes
 * a 12 s clip in about a second.
 */
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import {
  createLogMel,
  greedyCtc,
  loadBundledModel,
  parseTokens,
  type Vocabulary,
} from "@notefig/dictation/engine";
import { exposeWorkerApi } from "./worker-rpc";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };

let model: { session: ort.InferenceSession; vocab: Vocabulary; version: string } | null = null;
const logMel = createLogMel();

async function transcribe(pcm: Float32Array): Promise<{ text: string; ms: number }> {
  if (!model) throw new Error("dictation model not loaded");
  const started = performance.now();
  const { features, frames, nMels } = logMel(pcm);
  const outputs = await model.session.run({
    audio_signal: new ort.Tensor("float32", features, [1, nMels, frames]),
    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(frames)]), [1]),
  });
  const logprobs = outputs[model.session.outputNames[0]];
  const text = greedyCtc(logprobs.data as Float32Array, logprobs.dims[1], model.vocab);
  return { text, ms: performance.now() - started };
}

const api = {
  /** Loads the model from `baseUrl` once; later calls are no-ops. */
  async load(baseUrl: string): Promise<{ version: string; ms: number }> {
    const started = performance.now();
    if (!model) {
      const bundled = await loadBundledModel(new URL(baseUrl));
      const session = await ort.InferenceSession.create(bundled.bytes);
      model = { session, vocab: parseTokens(bundled.tokens), version: bundled.version };
      // Warm-up: the first run pays for kernel setup.
      await transcribe(new Float32Array(16_000));
    }
    return { version: model.version, ms: performance.now() - started };
  },
  transcribe,
};

export type DictationWorkerRpc = typeof api;

exposeWorkerApi(api);
