/**
 * NeMo-style log-mel features for the dictation model: preemphasis, a Hann
 * window, power spectrum, a triangular mel bank, log, then per-mel
 * normalization over the clip. Output is `[nMels × frames]`, mel-major, the
 * layout the model's `audio_signal` input takes.
 *
 * Ported from onnx-asr-web (MIT, github.com/SanderGi/onnx-asr-web) so the
 * features match what the model was measured with, with one change: its
 * power spectrum was a naive DFT (two trig calls per sample per bin, ~10× the
 * cost of the model itself); this uses a radix-2 FFT with precomputed
 * twiddles and gives the same values.
 */

export interface LogMelOptions {
  sampleRate: number;
  nMels: number;
  nFft: number;
  winLength: number;
  hopLength: number;
  preemphasis: number;
}

export const PARAKEET_FEATURES: LogMelOptions = {
  sampleRate: 16_000,
  nMels: 80,
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  preemphasis: 0.97,
};

export interface LogMel {
  features: Float32Array;
  frames: number;
  nMels: number;
}

const LOG_EPS = 1e-10;

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  }
  return window;
}

function melFilterBank(o: LogMelOptions): Float32Array[] {
  const nFreqs = o.nFft / 2 + 1;
  const melMax = hzToMel(o.sampleRate / 2);
  const bins = Array.from({ length: o.nMels + 2 }, (_, i) =>
    Math.floor(((o.nFft + 1) * melToHz((melMax * i) / (o.nMels + 1))) / o.sampleRate),
  );
  return Array.from({ length: o.nMels }, (_, m) => {
    const filter = new Float32Array(nFreqs);
    const [left, center, right] = [bins[m], bins[m + 1], bins[m + 2]];
    for (let k = left; k < center && k < nFreqs; k++) {
      filter[k] = (k - left) / (center - left);
    }
    for (let k = center; k < right && k < nFreqs; k++) {
      filter[k] = (right - k) / (right - center);
    }
    return filter;
  });
}

/** In-place radix-2 FFT plan for one size: bit reversal plus twiddles. */
export function createFft(n: number) {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
  const bits = Math.log2(n);
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  /** |X[k]|² for k in 0..n/2 of a real frame. */
  return function powerSpectrum(frame: Float32Array): Float32Array {
    for (let i = 0; i < n; i++) {
      re[reversed[i]] = frame[i];
      im[reversed[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = start + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const out = new Float32Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
    return out;
  };
}

/** Preemphasis, padded to at least one window. */
function preemphasize(input: Float32Array, coefficient: number, minLength: number): Float32Array {
  const samples = new Float32Array(Math.max(input.length, minLength));
  samples[0] = input[0] ?? 0;
  for (let i = 1; i < input.length; i++) samples[i] = input[i] - coefficient * input[i - 1];
  return samples;
}

/** Each mel row to zero mean and unit variance over the clip (NeMo's "per_feature"). */
function normalizePerMel(features: Float32Array, nMels: number, frames: number): void {
  for (let m = 0; m < nMels; m++) {
    const row = features.subarray(m * frames, (m + 1) * frames);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= frames;
    let variance = 0;
    for (const v of row) variance += (v - mean) ** 2;
    const std = Math.sqrt(variance / frames) + 1e-5;
    for (let t = 0; t < frames; t++) row[t] = (row[t] - mean) / std;
  }
}

/** Builds the window, mel bank and FFT once; call the result per clip. */
export function createLogMel(o: LogMelOptions = PARAKEET_FEATURES) {
  const window = hannWindow(o.winLength);
  const bank = melFilterBank(o);
  const powerSpectrum = createFft(o.nFft);
  const frame = new Float32Array(o.nFft);

  /** Log mel energies of the frame starting at `start`, into column `t`. */
  const melColumn = (samples: Float32Array, start: number, features: Float32Array, t: number, frames: number) => {
    frame.fill(0);
    for (let i = 0; i < o.winLength; i++) frame[i] = samples[start + i] * window[i];
    const spectrum = powerSpectrum(frame);
    for (let m = 0; m < o.nMels; m++) {
      const filter = bank[m];
      let energy = 0;
      for (let k = 0; k < spectrum.length; k++) energy += spectrum[k] * filter[k];
      features[m * frames + t] = Math.log(Math.max(LOG_EPS, energy));
    }
  };

  return function logMel(input: Float32Array): LogMel {
    const samples = preemphasize(input, o.preemphasis, o.winLength);
    const frames = 1 + Math.floor((samples.length - o.winLength) / o.hopLength);
    const features = new Float32Array(o.nMels * frames);
    for (let t = 0; t < frames; t++) melColumn(samples, t * o.hopLength, features, t, frames);
    normalizePerMel(features, o.nMels, frames);
    return { features, frames, nMels: o.nMels };
  };
}
