/**
 * The microphone for dictation: `getUserMedia` into an AudioWorklet that
 * hands back raw frames, resampled here to the model's 16 kHz mono. Capture
 * runs at the device's own rate because a 16 kHz AudioContext fed from a
 * 48 kHz stream fails in Firefox and resamples poorly elsewhere.
 *
 * The same code serves the web build and the Tauri webview; the macOS app
 * declares NSMicrophoneUsageDescription and the audio-input entitlement so
 * the system prompt can appear.
 */

export interface Microphone {
  /** Subscribes to 16 kHz mono audio; returns the unsubscribe. */
  onAudio(listener: (samples: Float32Array) => void): () => void;
  /** Resolves once audio held back for batching has been delivered. */
  flush(): Promise<void>;
  close(): void;
}

export type OpenMicrophone = () => Promise<Microphone>;

const TARGET_RATE = 16_000;

/** Hands audio over in ~40 ms batches rather than every 128-sample render
 *  quantum: a few dozen messages a second for the main thread, not 375. */
const TAP_WORKLET = `class DictationTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
    // "flush": send what's held, then say so (port order is kept).
    this.port.onmessage = () => {
      if (this.filled) this.port.postMessage(this.buffer.slice(0, this.filled));
      this.filled = 0;
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.filled + channel.length > this.buffer.length) {
      this.port.postMessage(this.buffer.slice(0, this.filled));
      this.filled = 0;
    }
    this.buffer.set(channel, this.filled);
    this.filled += channel.length;
    return true;
  }
}
registerProcessor("dictation-tap", DictationTap);`;

/**
 * Downsampler to 16 kHz: each output sample is the mean of the input
 * samples it covers, a cheap low-pass that keeps aliasing out of the speech
 * band. Stateful across calls, so frame boundaries don't click.
 */
export function createResampler(inputRate: number, outputRate = TARGET_RATE) {
  const step = inputRate / outputRate;
  let position = 0; // fractional input index where the next output starts
  let carry = new Float32Array(0);
  return (input: Float32Array): Float32Array => {
    let samples = input;
    if (carry.length) {
      samples = new Float32Array(carry.length + input.length);
      samples.set(carry);
      samples.set(input, carry.length);
    }
    const out = new Float32Array(Math.max(0, Math.floor((samples.length - position) / step)));
    for (let o = 0; o < out.length; o++, position += step) {
      const start = Math.floor(position);
      const end = Math.floor(position + step);
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i];
      out[o] = sum / Math.max(1, end - start);
    }
    const consumed = Math.floor(position);
    carry = samples.slice(consumed);
    position -= consumed;
    return out;
  };
}

export const openBrowserMicrophone: OpenMicrophone = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't record audio.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  const context = new AudioContext();
  try {
    const moduleUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    await context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    void context.close();
    throw error;
  }
  const tap = new AudioWorkletNode(context, "dictation-tap");
  context.createMediaStreamSource(stream).connect(tap);
  const resample = createResampler(context.sampleRate);
  const listeners = new Set<(samples: Float32Array) => void>();
  const flushed: (() => void)[] = [];
  tap.port.onmessage = (event: MessageEvent<Float32Array | "flushed">) => {
    if (event.data === "flushed") return flushed.shift()?.();
    const samples = resample(event.data);
    if (samples.length) listeners.forEach((l) => l(samples));
  };
  return {
    onAudio(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush() {
      return new Promise<void>((resolve) => {
        flushed.push(resolve);
        tap.port.postMessage("flush");
      });
    },
    close() {
      flushed.splice(0).forEach((resolve) => resolve());
      listeners.clear();
      tap.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
};
