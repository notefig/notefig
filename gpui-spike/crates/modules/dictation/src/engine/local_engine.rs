//! The speech engine the dictation service is handed — the Rust form of
//! `engine/worker-engine.ts` + `dictation.worker.ts`. The TS ran
//! onnxruntime-web in a Web Worker; here the model runs on the executor's
//! blocking pool, behind [`SpeechModel`], so the ONNX runtime is a drop-in.
//!
//! The backend is `engine::onnx` (feature `onnx`, on by default);
//! [`unavailable_model`] stands in for builds without it.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, ExecutorExt};
use std::cell::RefCell;

use super::ctc::{Vocabulary, greedy_ctc, parse_tokens};
use super::load_model::{BundledModel, load_bundled_model_from_dir};
use super::log_mel::{LogMelExtractor, PARAKEET_FEATURES, create_log_mel};
use crate::dictation::DictationEngine;

/// What the ONNX session does: `audio_signal [1, n_mels, frames]` (and its
/// length) in, log-probs out. Returns `(logprobs, frames)` with `logprobs`
/// `[frames × vocab]`, frame-major (the model's `[1, T, V]`).
pub trait SpeechModel: Send {
    fn run(&mut self, features: &[f32], n_mels: usize, frames: usize) -> anyhow::Result<(Vec<f32>, usize)>;
}

/// Builds a [`SpeechModel`] from the bundled model's bytes (the ONNX file).
pub type SpeechModelFactory = Arc<dyn Fn(&[u8]) -> anyhow::Result<Box<dyn SpeechModel>> + Send + Sync>;

/// The factory this build has: no inference backend (see the module docs).
pub fn unavailable_model() -> SpeechModelFactory {
    Arc::new(|_| anyhow::bail!("Dictation isn't available in this build: no speech inference backend (onnxruntime) is bundled."))
}

/// Where the bundled model comes from.
pub enum ModelSource {
    /// A folder holding `manifest.json` and its chunks.
    Dir(PathBuf),
    /// Already read (tests).
    Bundled(Box<dyn Fn() -> anyhow::Result<BundledModel> + Send + Sync>),
}

struct Loaded {
    model: Box<dyn SpeechModel>,
    vocab: Vocabulary,
    log_mel: LogMelExtractor,
}

impl Loaded {
    fn transcribe(&mut self, pcm: &[f32]) -> anyhow::Result<String> {
        let mel = self.log_mel.compute(pcm);
        let (logprobs, frames) = self.model.run(&mel.features, mel.n_mels, mel.frames)?;
        Ok(greedy_ctc(&logprobs, frames, &self.vocab))
    }
}

type Slot = Arc<Mutex<Option<Loaded>>>;

/// [`DictationEngine`] over the bundled model, run off the main thread.
pub struct LocalEngine {
    executor: Rc<dyn Executor>,
    source: Arc<ModelSource>,
    factory: SpeechModelFactory,
    /// The load in progress or done; a failed one is forgotten so the next
    /// call starts afresh (the TS replaced its dead worker the same way).
    started: RefCell<Option<Shared<LocalBoxFuture<'static, Result<Slot, String>>>>>,
}

pub fn create_local_engine(executor: Rc<dyn Executor>, source: ModelSource, factory: SpeechModelFactory) -> LocalEngine {
    LocalEngine { executor, source: Arc::new(source), factory, started: RefCell::new(None) }
}

impl LocalEngine {
    fn loaded(self: &Rc<Self>) -> Shared<LocalBoxFuture<'static, Result<Slot, String>>> {
        if let Some(started) = self.started.borrow().clone() {
            return started;
        }
        let (source, factory) = (self.source.clone(), self.factory.clone());
        let load = self.executor.blocking(move || -> Result<Slot, String> {
            let bundled = match &*source {
                ModelSource::Dir(dir) => load_bundled_model_from_dir(dir),
                ModelSource::Bundled(read) => read(),
            }
            .map_err(|e| format!("{e:#}"))?;
            let model = factory(&bundled.bytes).map_err(|e| format!("{e:#}"))?;
            let mut loaded = Loaded { model, vocab: parse_tokens(&bundled.tokens), log_mel: create_log_mel(PARAKEET_FEATURES) };
            // Warm-up: the first run pays for kernel setup.
            loaded.transcribe(&vec![0.0; 16_000]).map_err(|e| format!("{e:#}"))?;
            Ok(Arc::new(Mutex::new(Some(loaded))))
        });
        let this = Rc::downgrade(self);
        let started = async move {
            let result = load.await;
            if result.is_err() {
                if let Some(this) = this.upgrade() {
                    this.started.borrow_mut().take();
                }
            }
            result
        }
        .boxed_local()
        .shared();
        *self.started.borrow_mut() = Some(started.clone());
        started
    }
}

/// The `Rc` is what the engine is shared as; [`DictationEngine`] is
/// implemented on it so a load can forget itself on failure.
impl DictationEngine for Rc<LocalEngine> {
    fn load(&self) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let loaded = self.loaded();
        async move { loaded.await.map(|_| ()).map_err(anyhow::Error::msg) }.boxed_local()
    }

    fn transcribe(&self, samples: Vec<f32>) -> LocalBoxFuture<'static, anyhow::Result<String>> {
        let loaded = self.loaded();
        let executor = self.executor.clone();
        async move {
            let slot = loaded.await.map_err(anyhow::Error::msg)?;
            executor
                .blocking(move || {
                    let mut guard = slot.lock().unwrap();
                    match guard.as_mut() {
                        Some(model) => model.transcribe(&samples).map_err(|e| format!("{e:#}")),
                        None => Err("dictation model not loaded".to_string()),
                    }
                })
                .await
                .map_err(anyhow::Error::msg)
        }
        .boxed_local()
    }
}
