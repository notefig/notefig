//! Port of `packages/dictation/src/microphone.ts`: the microphone the
//! dictation listens to, and the downsampler to the model's 16 kHz mono.
//! The desktop implementation is `native_mic` (cpal), behind the
//! `native-mic` feature; the TS one was `getUserMedia` + an AudioWorklet.

use std::rc::Rc;

use futures::future::LocalBoxFuture;
use notefig_core::Subscription;

pub const TARGET_RATE: u32 = 16_000;

pub trait Microphone {
    /// Subscribes to 16 kHz mono audio, delivered on the main thread.
    fn on_audio(&self, listener: Box<dyn Fn(&[f32])>) -> Subscription;
    /// Resolves once audio held back for batching has been delivered.
    fn flush(&self) -> LocalBoxFuture<'static, ()>;
    /// Whether it still works: its stream runs and sound came in lately. A
    /// mic kept open between dictations can stop without a word (the system
    /// hands the device to another app) and then delivers nothing.
    fn live(&self) -> bool;
    fn close(&self);
}

/// Opens the microphone (`OpenMicrophone`). Rejects with the reason it
/// can't (a refused permission, no device).
pub type OpenMicrophone = Rc<dyn Fn() -> LocalBoxFuture<'static, anyhow::Result<Rc<dyn Microphone>>>>;

/// Downsampler to `output_rate`: each output sample is the mean of the input
/// samples it covers, a cheap low-pass that keeps aliasing out of the speech
/// band. Stateful across calls, so frame boundaries don't click.
pub struct Resampler {
    step: f64,
    /// Fractional input index where the next output starts.
    position: f64,
    carry: Vec<f32>,
}

pub fn create_resampler(input_rate: u32, output_rate: u32) -> Resampler {
    Resampler { step: input_rate as f64 / output_rate as f64, position: 0.0, carry: Vec::new() }
}

impl Resampler {
    pub fn resample(&mut self, input: &[f32]) -> Vec<f32> {
        let mut samples = std::mem::take(&mut self.carry);
        samples.extend_from_slice(input);
        let count = ((samples.len() as f64 - self.position) / self.step).floor().max(0.0) as usize;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let start = self.position.floor() as usize;
            let end = (self.position + self.step).floor() as usize;
            let sum: f32 = samples[start..end.min(samples.len())].iter().sum();
            out.push(sum / (end - start).max(1) as f32);
            self.position += self.step;
        }
        let consumed = self.position.floor() as usize;
        self.carry = samples[consumed.min(samples.len())..].to_vec();
        self.position -= consumed as f64;
        out
    }
}
