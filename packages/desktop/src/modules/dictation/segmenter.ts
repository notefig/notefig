/**
 * Splits a dictation into phrases at the speaker's pauses, so each phrase can
 * be decoded while they keep talking and releasing the key only waits for
 * the last one. A phrase ends in the middle of a pause of at least
 * `pauseMs`, once it holds `minPhraseMs` of audio; a phrase that runs on
 * without a pause is cut at `maxPhraseMs` to bound the wait.
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

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: 16_000,
  pauseMs: 400,
  minPhraseMs: 2_000,
  // Bounds a live re-decode of the current phrase to under a second.
  maxPhraseMs: 10_000,
};

const FRAME_MS = 20;
/** Absolute floor: below this RMS everything counts as silence. */
const MIN_SPEECH_RMS = 0.004;
/** Per-frame rise of the noise floor while nothing quieter is heard. */
const FLOOR_RISE = 1.003;

export interface Segmenter {
  /** Feeds audio; returns any phrases it completed. */
  push(samples: Float32Array): Float32Array[];
  /** Whether the phrase so far has any speech in it (silence decodes to
   *  stray punctuation or a hallucinated "I."). */
  hasSpeech(): boolean;
  /** The phrase so far, without ending it (for a live guess). */
  peek(): Float32Array;
  /** Everything not yet returned, as the last phrase (empty if none). */
  flush(): Float32Array;
}

export function createSegmenter(options: SegmenterOptions = DEFAULT_SEGMENTER): Segmenter {
  const frameLength = (options.sampleRate * FRAME_MS) / 1000;
  const toFrames = (ms: number) => Math.round(ms / FRAME_MS);
  let pending: number[] = []; // samples not yet framed
  let frames: Float32Array[] = []; // frames of the current phrase
  let silentRun = 0;
  let heardSpeech = false;
  let noiseFloor = MIN_SPEECH_RMS;

  const takePhrase = (frameCount: number) => {
    const phrase = new Float32Array(frameCount * frameLength);
    frames.slice(0, frameCount).forEach((f, i) => phrase.set(f, i * frameLength));
    frames = frames.slice(frameCount);
    heardSpeech = false;
    return phrase;
  };

  const onFrame = (frame: Float32Array): Float32Array | null => {
    let energy = 0;
    for (const s of frame) energy += s * s;
    const rms = Math.sqrt(energy / frame.length);
    noiseFloor = rms < noiseFloor ? Math.max(rms, 1e-5) : noiseFloor * FLOOR_RISE;
    const silent = rms < Math.max(MIN_SPEECH_RMS, noiseFloor * 3);
    frames.push(frame);
    silentRun = silent ? silentRun + 1 : 0;
    if (!silent) heardSpeech = true;

    const long = frames.length >= toFrames(options.minPhraseMs);
    if (heardSpeech && long && silentRun >= toFrames(options.pauseMs)) {
      // Cut in the middle of the pause: both phrases keep some silence.
      return takePhrase(frames.length - Math.floor(silentRun / 2));
    }
    if (frames.length >= toFrames(options.maxPhraseMs)) return takePhrase(frames.length);
    return null;
  };

  return {
    push(samples) {
      const phrases: Float32Array[] = [];
      for (const s of samples) {
        pending.push(s);
        if (pending.length === frameLength) {
          const phrase = onFrame(Float32Array.from(pending));
          pending = [];
          if (phrase) phrases.push(phrase);
        }
      }
      return phrases;
    },
    hasSpeech: () => heardSpeech,
    peek() {
      const out = new Float32Array(frames.length * frameLength + pending.length);
      frames.forEach((f, i) => out.set(f, i * frameLength));
      out.set(pending, frames.length * frameLength);
      return out;
    },
    flush() {
      const out = this.peek();
      frames = [];
      pending = [];
      heardSpeech = false;
      silentRun = 0;
      return out;
    },
  };
}
