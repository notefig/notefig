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
  close(): void;
}

export type OpenMicrophone = () => Promise<Microphone>;

const TARGET_RATE = 16_000;

const TAP_WORKLET = `class DictationTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
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
  let carry: number[] = [];
  return (input: Float32Array): Float32Array => {
    const samples = carry.length ? Float32Array.from([...carry, ...input]) : input;
    const out: number[] = [];
    while (position + step <= samples.length) {
      const start = Math.floor(position);
      const end = Math.floor(position + step);
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i];
      out.push(sum / Math.max(1, end - start));
      position += step;
    }
    const consumed = Math.floor(position);
    carry = Array.from(samples.subarray(consumed));
    position -= consumed;
    return Float32Array.from(out);
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
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const samples = resample(event.data);
    if (samples.length) listeners.forEach((l) => l(samples));
  };
  return {
    onAudio(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      tap.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
};
