//! Port of `packages/dictation/src/segmenter.ts`.
//!
//! Splits a dictation into phrases at the speaker's pauses, so each phrase can
//! be decoded while they keep talking and releasing the key only waits for
//! the last one. A phrase ends in the middle of a pause of at least
//! `pause_ms`, once it holds `min_phrase_ms` of audio. One that runs on
//! without a pause is cut at `max_phrase_ms`, at its quietest moment in the
//! last 1.5 s (most likely between words).
//!
//! Silence is judged per 20 ms frame against the room's noise floor: it drops
//! to any quieter frame at once and creeps up slowly otherwise (~16% a
//! second), so the gaps between words keep it near the room's level.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmenterOptions {
    pub sample_rate: u32,
    pub pause_ms: u32,
    pub min_phrase_ms: u32,
    pub max_phrase_ms: u32,
}

/// See the TS comment: fewer, longer phrases keep most of the accuracy a cut
/// costs while still bounding one decode to ~0.65 s.
pub const DEFAULT_SEGMENTER: SegmenterOptions = SegmenterOptions {
    sample_rate: 16_000,
    pause_ms: 500,
    min_phrase_ms: 4_000,
    max_phrase_ms: 8_000,
};

const FRAME_MS: u32 = 20;
/// Absolute floor: below this RMS everything counts as silence.
const MIN_SPEECH_RMS: f32 = 0.004;
/// Per-frame rise of the noise floor while nothing quieter is heard.
const FLOOR_RISE: f32 = 1.003;
/// How far back a forced cut looks for its quietest frame.
const FORCED_CUT_WINDOW_MS: u32 = 1_500;

struct Frame {
    samples: Vec<f32>,
    rms: f32,
    silent: bool,
}

pub struct Segmenter {
    options: SegmenterOptions,
    frame_length: usize,
    pending: Vec<f32>,
    filled: usize,
    frames: Vec<Frame>,
    silent_run: usize,
    noise_floor: f32,
}

fn to_frames(ms: u32) -> usize {
    (ms as f32 / FRAME_MS as f32).round() as usize
}

fn join(parts: &[&[f32]]) -> Vec<f32> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

pub fn create_segmenter(options: SegmenterOptions) -> Segmenter {
    let frame_length = (options.sample_rate * FRAME_MS / 1000) as usize;
    Segmenter {
        options,
        frame_length,
        pending: vec![0.0; frame_length],
        filled: 0,
        frames: Vec::new(),
        silent_run: 0,
        noise_floor: MIN_SPEECH_RMS,
    }
}

impl Default for Segmenter {
    fn default() -> Self {
        create_segmenter(DEFAULT_SEGMENTER)
    }
}

impl Segmenter {
    fn take_phrase(&mut self, frame_count: usize) -> Vec<f32> {
        let rest = self.frames.split_off(frame_count);
        let taken = std::mem::replace(&mut self.frames, rest);
        join(&taken.iter().map(|f| f.samples.as_slice()).collect::<Vec<_>>())
    }

    /// The frame to cut after when a phrase runs too long: the quietest recent one.
    fn quietest_recent(&self) -> usize {
        let mut best = self.frames.len() - 1;
        let start = self.frames.len().saturating_sub(to_frames(FORCED_CUT_WINDOW_MS));
        for i in start..self.frames.len() {
            if self.frames[i].rms < self.frames[best].rms {
                best = i;
            }
        }
        best + 1
    }

    fn on_frame(&mut self, samples: Vec<f32>) -> Option<Vec<f32>> {
        let energy: f32 = samples.iter().map(|s| s * s).sum();
        let rms = (energy / samples.len() as f32).sqrt();
        self.noise_floor = if rms < self.noise_floor { rms.max(1e-5) } else { self.noise_floor * FLOOR_RISE };
        let silent = rms < MIN_SPEECH_RMS.max(self.noise_floor * 3.0);
        self.frames.push(Frame { samples, rms, silent });
        self.silent_run = if silent { self.silent_run + 1 } else { 0 };

        let long = self.frames.len() >= to_frames(self.options.min_phrase_ms);
        if long && self.silent_run >= to_frames(self.options.pause_ms) && self.has_speech() {
            // Cut in the middle of the pause: both phrases keep some silence.
            let at = self.frames.len() - self.silent_run / 2;
            return Some(self.take_phrase(at));
        }
        if self.frames.len() >= to_frames(self.options.max_phrase_ms) {
            // Nothing said all this while: let the silence go rather than decode it.
            if !self.has_speech() {
                let keep = to_frames(self.options.pause_ms);
                let drop = self.frames.len().saturating_sub(keep);
                self.frames.drain(..drop);
                return None;
            }
            let at = self.quietest_recent();
            return Some(self.take_phrase(at));
        }
        None
    }

    /// Feeds audio; returns any phrases it completed.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let mut phrases = Vec::new();
        let mut i = 0;
        while i < samples.len() {
            let n = (self.frame_length - self.filled).min(samples.len() - i);
            self.pending[self.filled..self.filled + n].copy_from_slice(&samples[i..i + n]);
            self.filled += n;
            i += n;
            if self.filled == self.frame_length {
                self.filled = 0;
                let frame = self.pending.clone();
                if let Some(phrase) = self.on_frame(frame) {
                    phrases.push(phrase);
                }
            }
        }
        phrases
    }

    /// Whether the phrase so far has any speech in it (silence decodes to
    /// stray punctuation or a hallucinated "I.").
    pub fn has_speech(&self) -> bool {
        self.frames.iter().any(|f| !f.silent)
    }

    /// How long it has been quiet, in ms (0 while someone is talking).
    pub fn quiet_ms(&self) -> u32 {
        self.silent_run as u32 * FRAME_MS
    }

    /// Whether there's speech in the phrase so far past its first `samples`.
    pub fn speech_after(&self, samples: usize) -> bool {
        self.frames.iter().skip(samples / self.frame_length).any(|f| !f.silent)
    }

    /// The phrase so far, without ending it (for a live guess).
    pub fn peek(&self) -> Vec<f32> {
        let mut parts: Vec<&[f32]> = self.frames.iter().map(|f| f.samples.as_slice()).collect();
        parts.push(&self.pending[..self.filled]);
        join(&parts)
    }

    /// Everything not yet returned, as the last phrase (empty if none).
    pub fn flush(&mut self) -> Vec<f32> {
        let out = self.peek();
        self.frames.clear();
        self.filled = 0;
        self.silent_run = 0;
        out
    }
}
