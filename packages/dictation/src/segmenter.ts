/**
 * Splits a dictation into phrases at the speaker's pauses, so each phrase can
 * be decoded while they keep talking and releasing the key only waits for
 * the last one. A phrase ends in the middle of a pause of at least
 * `pauseMs`, once it holds `minPhraseMs` of audio. One that runs on without
 * a pause is cut at `maxPhraseMs`, at its quietest moment in the last 1.5 s
 * (most likely between words): every decode stays short, and so does the
 * wait after release.
 *
 * Silence is judged per 20 ms frame against the room's noise floor: it drops
 * to any quieter frame at once and creeps up slowly otherwise (~16% a
 * second), so the gaps between words keep it near the room's level and a
 * noisy room still finds its pauses after a few seconds.
 */

export interface SegmenterOptions {
  sampleRate: number;
  pauseMs: number;
  minPhraseMs: number;
  maxPhraseMs: number;
}

/**
 * Each phrase is decoded on its own, without the words around it, so every
 * cut costs some accuracy: on our 100 test clips, cutting at 400 ms pauses
 * from 2 s with a 5 s cap gave 14.6% WER against 11.8% for whole clips.
 * Fewer, longer phrases get most of it back (13.0%) while still bounding a
 * decode (a live guess, the last phrase) to ~0.65 s. Anything under 4 s is
 * never cut, so short dictations are decoded whole.
 */
export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: 16_000,
  pauseMs: 500,
  minPhraseMs: 4_000,
  maxPhraseMs: 8_000,
};

const FRAME_MS = 20;
/** Absolute floor: below this RMS everything counts as silence. */
const MIN_SPEECH_RMS = 0.004;
/** Per-frame rise of the noise floor while nothing quieter is heard. */
const FLOOR_RISE = 1.003;
/** How far back a forced cut looks for its quietest frame. */
const FORCED_CUT_WINDOW_MS = 1_500;

interface Frame {
  samples: Float32Array;
  rms: number;
  silent: boolean;
}

export interface Segmenter {
  /** Feeds audio; returns any phrases it completed. */
  push(samples: Float32Array): Float32Array[];
  /** Whether the phrase so far has any speech in it (silence decodes to
   *  stray punctuation or a hallucinated "I."). */
  hasSpeech(): boolean;
  /** How long it has been quiet, in ms (0 while someone is talking). */
  quietMs(): number;
  /** Whether there's speech in the phrase so far past its first `samples`. */
  speechAfter(samples: number): boolean;
  /** The phrase so far, without ending it (for a live guess). */
  peek(): Float32Array;
  /** Everything not yet returned, as the last phrase (empty if none). */
  flush(): Float32Array;
}

export function createSegmenter(options: SegmenterOptions = DEFAULT_SEGMENTER): Segmenter {
  const frameLength = (options.sampleRate * FRAME_MS) / 1000;
  const toFrames = (ms: number) => Math.round(ms / FRAME_MS);
  // Samples not yet a whole frame, then the current phrase's frames.
  const pending = new Float32Array(frameLength);
  let filled = 0;
  let frames: Frame[] = [];
  let silentRun = 0;
  let noiseFloor = MIN_SPEECH_RMS;

  const join = (parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  const takePhrase = (frameCount: number) => {
    const phrase = join(frames.slice(0, frameCount).map((f) => f.samples));
    frames = frames.slice(frameCount);
    return phrase;
  };

  /** The frame to cut after when a phrase runs too long: the quietest recent one. */
  const quietestRecent = () => {
    let best = frames.length - 1;
    for (let i = Math.max(0, frames.length - toFrames(FORCED_CUT_WINDOW_MS)); i < frames.length; i++) {
      if (frames[i].rms < frames[best].rms) best = i;
    }
    return best + 1;
  };

  const onFrame = (samples: Float32Array): Float32Array | null => {
    let energy = 0;
    for (const s of samples) energy += s * s;
    const rms = Math.sqrt(energy / samples.length);
    noiseFloor = rms < noiseFloor ? Math.max(rms, 1e-5) : noiseFloor * FLOOR_RISE;
    const silent = rms < Math.max(MIN_SPEECH_RMS, noiseFloor * 3);
    frames.push({ samples, rms, silent });
    silentRun = silent ? silentRun + 1 : 0;

    const long = frames.length >= toFrames(options.minPhraseMs);
    if (long && silentRun >= toFrames(options.pauseMs) && hasSpeech()) {
      // Cut in the middle of the pause: both phrases keep some silence.
      return takePhrase(frames.length - Math.floor(silentRun / 2));
    }
    if (frames.length >= toFrames(options.maxPhraseMs)) {
      // Nothing said all this while: let the silence go rather than decode it.
      if (!hasSpeech()) {
        frames = frames.slice(-toFrames(options.pauseMs));
        return null;
      }
      return takePhrase(quietestRecent());
    }
    return null;
  };

  const hasSpeech = () => frames.some((f) => !f.silent);

  return {
    push(samples) {
      const phrases: Float32Array[] = [];
      for (let i = 0; i < samples.length; ) {
        const n = Math.min(frameLength - filled, samples.length - i);
        pending.set(samples.subarray(i, i + n), filled);
        filled += n;
        i += n;
        if (filled === frameLength) {
          filled = 0;
          const phrase = onFrame(pending.slice());
          if (phrase) phrases.push(phrase);
        }
      }
      return phrases;
    },
    hasSpeech,
    quietMs: () => silentRun * FRAME_MS,
    speechAfter: (samples) => frames.slice(Math.floor(samples / frameLength)).some((f) => !f.silent),
    peek: () => join([...frames.map((f) => f.samples), pending.subarray(0, filled)]),
    flush() {
      const out = this.peek();
      frames = [];
      filled = 0;
      silentRun = 0;
      return out;
    },
  };
}
