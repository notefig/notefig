//! The ONNX backend: the bundled Parakeet CTC model on onnxruntime (`ort`),
//! the Rust form of `dictation.worker.ts`'s `ort.InferenceSession`. One
//! intra-op thread, as the TS worker ran one WebAssembly thread; the
//! session runs on the executor's blocking pool.

use std::sync::{Arc, OnceLock};

use ort::environment::Environment;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use super::local_engine::{SpeechModel, SpeechModelFactory};

struct OnnxModel {
    session: Session,
    /// Sessions live under an environment; it stays up as long as they do.
    _env: Environment,
}

/// The process's onnxruntime environment, telemetry off.
fn environment() -> anyhow::Result<Environment> {
    static ENV: OnceLock<Environment> = OnceLock::new();
    if let Some(env) = ENV.get() {
        return Ok(env.clone());
    }
    let env = ort::init()
        .with_name("notefig-dictation")
        .with_telemetry(false)
        .build()
        .map_err(|e| anyhow::anyhow!("onnxruntime: {e}"))?;
    Ok(ENV.get_or_init(|| env).clone())
}

impl SpeechModel for OnnxModel {
    fn run(&mut self, features: &[f32], n_mels: usize, frames: usize) -> anyhow::Result<(Vec<f32>, usize)> {
        let audio = Tensor::from_array(([1usize, n_mels, frames], features.to_vec().into_boxed_slice()))?;
        let length = Tensor::from_array(([1usize], vec![frames as i64].into_boxed_slice()))?;
        let outputs = self.session.run(ort::inputs!["audio_signal" => audio, "length" => length])?;
        let (shape, logprobs) = outputs[0].try_extract_tensor::<f32>()?;
        // `[1, T, V]`: T is the model's frame count after subsampling.
        let out_frames = shape.get(1).copied().unwrap_or(0).max(0) as usize;
        Ok((logprobs.to_vec(), out_frames))
    }
}

/// Builds sessions from the bundled model's bytes.
pub fn onnx_model() -> SpeechModelFactory {
    Arc::new(|bytes: &[u8]| {
        // The builder's errors carry the builder (not Send): keep the message.
        let err = |e: ort::Error| anyhow::anyhow!("onnxruntime: {e}");
        let env = environment()?;
        let session = Session::builder(&env)
            .map_err(err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| err(e.into()))?
            .with_intra_threads(1)
            .map_err(|e| err(e.into()))?
            .commit_from_memory(bytes)
            .map_err(err)?;
        Ok(Box::new(OnnxModel { session, _env: env }) as Box<dyn SpeechModel>)
    })
}
