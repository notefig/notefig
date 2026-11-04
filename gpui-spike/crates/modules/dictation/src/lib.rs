//! Push-to-talk dictation: a port of `packages/dictation` (the service, the
//! segmenter, the editor contract, the microphone, the speech engine) and
//! `packages/desktop/src/modules/dictation` (the module, `core.dictation`).
//!
//! Hold the dictation key, talk, release, and the words land at the caret of
//! the focused editor. Editors implement [`DictationTarget`]; the key comes
//! from the platform's key monitor (`notefig-view-dictation`), which calls
//! [`DictationApi::modifier_changed`] and [`DictationApi::escape`].
//!
//! The speech model's inference backend is a trait ([`SpeechModel`]); this
//! build has none (see `engine::local_engine`), so a dictation reports
//! "Dictation isn't available in this build" instead of inserting text.

mod dictation;
pub mod engine;
mod microphone;
#[cfg(feature = "native-mic")]
mod native_mic;
mod segmenter;
mod target;

pub use dictation::{
    DictationApi, DictationDeps, DictationEngine, DictationHoldKey, DictationState, DictationStatus, KeyPlatform,
    ModifierKey, NO_SOUND_ERROR, create_dictation, dictation_hold_key, hold_key_label, join_phrases,
};
/// The inference backend this build has: onnxruntime, or none.
pub fn speech_model() -> SpeechModelFactory {
    #[cfg(feature = "onnx")]
    return engine::onnx::onnx_model();
    #[cfg(not(feature = "onnx"))]
    return unavailable_model();
}

pub use engine::local_engine::{LocalEngine, ModelSource, SpeechModel, SpeechModelFactory, create_local_engine, unavailable_model};
pub use microphone::{Microphone, OpenMicrophone, Resampler, TARGET_RATE, create_resampler};
#[cfg(feature = "native-mic")]
pub use native_mic::native_microphone;
pub use segmenter::{DEFAULT_SEGMENTER, Segmenter, SegmenterOptions, create_segmenter};
pub use target::{DictationInsertion, DictationTarget, fit_dictation};

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use notefig_core::{ExecutorExt, Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::KvModule;

/// The user's switch lives in the app settings namespace; `dictationUsed` is
/// this module's own: someone who has dictated before gets the model loaded
/// ahead of their next press.
pub const SETTINGS_NAMESPACE: &str = "settings";
pub const ENABLED_KEY: &str = "dictationEnabled";
pub const USED_KEY: &str = "dictationUsed";

/// Warm once the app has settled, so it never competes with startup.
const WARM_AFTER: Duration = Duration::from_secs(5);
const MIC_WARM: Duration = Duration::from_secs(30);

/// Where the bundled model is read from, in place: `NOTEFIG_DICTATION_MODEL`,
/// else the app bundle's `Resources/dictation`, else the TS app's
/// `packages/desktop/public/dictation` next to this checkout (dev builds).
pub fn bundled_model_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("NOTEFIG_DICTATION_MODEL") {
        return dir.into();
    }
    if let Some(resources) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("../Resources/dictation")))
        .filter(|d| d.join("manifest.json").exists())
    {
        return resources;
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../../notefig/packages/desktop/public/dictation"))
}

fn microphone(ctx: &ModuleContext) -> OpenMicrophone {
    #[cfg(feature = "native-mic")]
    {
        native_microphone(ctx.executor())
    }
    #[cfg(not(feature = "native-mic"))]
    {
        let _ = ctx;
        Rc::new(|| futures::future::ready(Err(anyhow::anyhow!("This build can't record audio."))).boxed_local())
    }
}

/// `dictationModule`: push-to-talk into the editors, on the bundled model.
pub struct DictationModule;

impl Module for DictationModule {
    const NAME: &'static str = "dictation";
    type Api = DictationApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<KvModule>()]
    }

    fn register(ctx: &ModuleContext) -> DictationApi {
        let kv = ctx.use_::<KvModule>();
        let executor = ctx.executor();
        let engine = Rc::new(create_local_engine(executor.clone(), ModelSource::Dir(bundled_model_dir()), speech_model()));
        let (kv_read, kv_write) = (kv.clone(), kv);
        create_dictation(DictationDeps {
            engine: Rc::new(engine),
            open_microphone: microphone(ctx),
            enabled: Rc::new(move || {
                let read = kv_read.read::<bool>(SETTINGS_NAMESPACE, ENABLED_KEY);
                async move { read.await.unwrap_or(true) }.boxed_local()
            }),
            on_dictated: Some(Rc::new(move || {
                let write = kv_write.write(SETTINGS_NAMESPACE, USED_KEY, &true);
                ctx_spawn(&executor, write);
            })),
            // DIVERGENCE: the TS holds right ⌥ on a Mac (`dictation_hold_key`);
            // the GPUI app holds right Ctrl everywhere, as the port's brief asks.
            hold_key: DictationHoldKey::ControlRight,
            warm: MIC_WARM,
            executor: ctx.executor(),
        })
    }

    fn boot(dictation: &Rc<DictationApi>, ctx: &ModuleContext) -> Option<Subscription> {
        // A failed dictation inserts nothing, so say why (the TS toasted;
        // the view crate shows the error, this logs it).
        let reporter = dictation.clone();
        let reporting = dictation.subscribe(move || {
            let state = reporter.state();
            if state.status == DictationStatus::Error {
                log::warn!("dictation failed: {}", state.error.unwrap_or_default());
            }
        });
        let kv = ctx.use_::<KvModule>();
        let executor = ctx.executor();
        let warming = Rc::new(std::cell::Cell::new(true));
        let (alive, api) = (warming.clone(), dictation.clone());
        let timer = executor.timer(WARM_AFTER);
        executor.spawn_local(async move {
            timer.await;
            if !alive.get() {
                return;
            }
            let used = kv.read::<bool>(SETTINGS_NAMESPACE, USED_KEY).await.unwrap_or(false);
            let enabled = kv.read::<bool>(SETTINGS_NAMESPACE, ENABLED_KEY).await.unwrap_or(true);
            if used && enabled && alive.get() {
                api.warm().await;
            }
        });
        let stopping = dictation.clone();
        Some(Subscription::join(vec![
            Subscription::new(move || warming.set(false)),
            reporting,
            Subscription::new(move || stopping.stop()),
        ]))
    }
}

fn ctx_spawn(executor: &Rc<dyn notefig_core::Executor>, write: futures::future::LocalBoxFuture<'static, anyhow::Result<()>>) {
    executor.spawn_local(async move {
        if let Err(err) = write.await {
            log::warn!("dictation: recording use failed: {err:#}");
        }
    });
}

#[cfg(test)]
mod tests;
