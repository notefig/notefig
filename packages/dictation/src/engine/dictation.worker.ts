/**
 * Dictation worker: runs the bundled speech model off the main thread.
 * onnxruntime-web on one WebAssembly thread — the app isn't cross-origin
 * isolated (that would break remote images in notes), and one thread decodes
 * a 12 s clip in about a second.
 */
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { exposeWorkerApi } from "@notefig/worker";
import { greedyCtc, parseTokens, type Vocabulary } from "./ctc";
import { loadBundledModel } from "./load-model";
import { createLogMel } from "./log-mel";
import type { DictationWorkerApi } from "./worker-engine";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };

let model: { session: ort.InferenceSession; vocab: Vocabulary } | null = null;
const logMel = createLogMel();

async function transcribe(pcm: Float32Array): Promise<string> {
  if (!model) throw new Error("dictation model not loaded");
  const { features, frames, nMels } = logMel(pcm);
  const outputs = await model.session.run({
    audio_signal: new ort.Tensor("float32", features, [1, nMels, frames]),
    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(frames)]), [1]),
  });
  const logprobs = outputs[model.session.outputNames[0]];
  return greedyCtc(logprobs.data as Float32Array, logprobs.dims[1], model.vocab);
}

/** Loads the model from `modelUrl` once; later calls are no-ops. */
async function load(modelUrl: string): Promise<void> {
  if (model) return;
  const bundled = await loadBundledModel(new URL(modelUrl));
  const session = await ort.InferenceSession.create(bundled.bytes);
  model = { session, vocab: parseTokens(bundled.tokens) };
  // Warm-up: the first run pays for kernel setup.
  await transcribe(new Float32Array(16_000));
}

exposeWorkerApi({ load, transcribe } satisfies DictationWorkerApi);
