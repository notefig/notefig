/** What passes between the dictation worker (dictation.worker.ts) and its
 *  client (worker-engine.ts). Apart from both, so the client's types don't
 *  pull the worker and onnxruntime into everything importing this package. */

export type WorkerCall = { method: "load"; modelUrl: string } | { method: "transcribe"; samples: Float32Array };

export type WorkerRequest = WorkerCall & { id: number };

export type WorkerResponse = { id: number; ok: true; text?: string } | { id: number; ok: false; error: string };
