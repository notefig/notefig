//! Port of `packages/dictation/src/dictation.ts`: push-to-talk dictation.
//! Hold the dictation key, talk, release, and the words land at the caret
//! of whichever editor has focus.
//!
//! Editors offer themselves as targets (`attach`); this service owns the
//! rest — the hold key's state, the microphone, and the speech engine it is
//! handed. Nothing leaves the device.
//!
//! Text streams while the speaker talks. Speech is split at their pauses;
//! each finished phrase is decoded once and settles. In between, whenever
//! the engine is free, the phrase still being spoken is decoded again from
//! its start, so the editor shows it growing. Releasing the key only waits
//! for the last phrase.
//!
//! JS promises run eagerly; Rust futures don't. Every chain the TS kept as a
//! promise (`decoding`, `opening`, the mic) is a `Shared` future that is
//! also spawned on the executor, so it makes progress whether or not anyone
//! awaits it — the same order of events as the TS.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, ExecutorExt, Listeners, Subscription};

use crate::microphone::{Microphone, OpenMicrophone};
use crate::segmenter::{DEFAULT_SEGMENTER, Segmenter, create_segmenter};
use crate::target::{DictationInsertion, DictationTarget, fit_dictation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationStatus {
    Idle,
    Starting,
    Listening,
    Finishing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictationState {
    pub status: DictationStatus,
    /// Why the last dictation failed, while `status` is `Error`.
    pub error: Option<String>,
}

impl DictationState {
    pub fn idle() -> Self {
        Self { status: DictationStatus::Idle, error: None }
    }
    fn with(status: DictationStatus) -> Self {
        Self { status, error: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationHoldKey {
    AltRight,
    ControlRight,
}

/// A modifier key as the OS reports it, by side (the TS `KeyboardEvent.code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModifierKey {
    ControlLeft,
    ControlRight,
    AltLeft,
    AltRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPlatform {
    Mac,
    Windows,
    Linux,
}

impl KeyPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Right ⌥ on a Mac; Right Ctrl elsewhere, where Right Alt is AltGr on many
/// layouts. (The TS default; the GPUI app's module picks Right Ctrl
/// everywhere, see `DictationModule`.)
pub fn dictation_hold_key(platform: KeyPlatform) -> DictationHoldKey {
    if platform == KeyPlatform::Mac { DictationHoldKey::AltRight } else { DictationHoldKey::ControlRight }
}

/// The hold key as people read it, in TanStack's symbols: "right ⌥", "right Ctrl".
pub fn hold_key_label(key: DictationHoldKey, platform: KeyPlatform) -> String {
    let symbol = match (key, platform == KeyPlatform::Mac) {
        (DictationHoldKey::AltRight, true) => "⌥",
        (DictationHoldKey::ControlRight, true) => "⌃",
        (DictationHoldKey::AltRight, false) => "Alt",
        (DictationHoldKey::ControlRight, false) => "Ctrl",
    };
    format!("right {symbol}")
}

/// The speech model, wherever it runs (the app's runs it off the main thread).
pub trait DictationEngine {
    /// Loads the model; cheap once loaded.
    fn load(&self) -> LocalBoxFuture<'static, anyhow::Result<()>>;
    fn transcribe(&self, samples: Vec<f32>) -> LocalBoxFuture<'static, anyhow::Result<String>>;
}

pub struct DictationDeps {
    pub engine: Rc<dyn DictationEngine>,
    pub open_microphone: OpenMicrophone,
    /// The user's setting; read at each key press.
    pub enabled: Rc<dyn Fn() -> LocalBoxFuture<'static, bool>>,
    /// Called after each dictation that inserted text.
    pub on_dictated: Option<Rc<dyn Fn()>>,
    pub hold_key: DictationHoldKey,
    /// How long the mic stays open after a dictation, for a quick follow-up.
    pub warm: Duration,
    pub executor: Rc<dyn Executor>,
}

const SAMPLE_RATE: usize = DEFAULT_SEGMENTER.sample_rate as usize;
const fn ms(n: usize) -> usize {
    SAMPLE_RATE * n / 1000
}
/// Speech from before the key went down that's kept, while the mic is warm.
const PREROLL_SAMPLES: usize = ms(300);
/// A tail shorter than this after release is silence, not worth decoding.
const MIN_TAIL_SAMPLES: usize = ms(300);
/// The live phrase is first decoded at this length, then after each step.
const MIN_LIVE_SAMPLES: usize = ms(300);
const LIVE_STEP_SAMPLES: usize = ms(250);
/// A speaker this quiet after new words gets a guess at once.
const SETTLE_QUIET_MS: u32 = 150;
/// A mic that sends nothing for this long after it opens isn't working.
const NO_SOUND: Duration = Duration::from_millis(1500);
pub const NO_SOUND_ERROR: &str = "The microphone isn't sending any sound.";
/// How long the mic gets to hand over its last batch on release.
const FLUSH_BUDGET: Duration = Duration::from_millis(150);

fn has_words(text: &str) -> bool {
    text.chars().any(|c| c.is_alphabetic() || c.is_numeric())
}

/// Joins phrases decoded one by one as if they had been one sentence. A
/// phrase that came back as bare punctuation is dropped, and a period
/// before a phrase the model began in lowercase was the cut's, not the
/// speaker's: the model ends every clip it hears with one.
pub fn join_phrases<S: AsRef<str>>(phrases: &[S]) -> String {
    phrases
        .iter()
        .map(AsRef::as_ref)
        .filter(|p| has_words(p))
        .fold(String::new(), |text, phrase| {
            let lowercase_start = phrase.trim().starts_with(|c: char| c.is_ascii_lowercase());
            let base = if lowercase_start { text.strip_suffix('.').unwrap_or(&text).to_string() } else { text };
            let fitted = fit_dictation(&base, "", phrase);
            base + &fitted
        })
        .trim()
        .to_string()
}

/// Microphone loudness as the wave shows it: -55 dBFS (room) to -15 (loud).
fn loudness(samples: &[f32]) -> f32 {
    let energy: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    let db = 10.0 * (energy / (samples.len().max(1) as f64) + 1e-12).log10();
    (((db + 55.0) / 40.0).clamp(0.0, 1.0)) as f32
}

type Chain = Shared<LocalBoxFuture<'static, ()>>;

fn ready_chain() -> Chain {
    futures::future::ready(()).boxed_local().shared()
}

struct LastGuess {
    raw: String,
    heard: usize,
    at: usize,
}

/// One dictation, key down to key up: cuts phrases at pauses and decodes
/// them in order, slips live guesses at the phrase in progress in between,
/// and joins the result. Decodes run one after another, so guesses back off
/// to leave the engine room: each waits at least half again as long as the
/// last one took.
struct Run {
    insertion: Rc<dyn DictationInsertion>,
    engine: Rc<dyn DictationEngine>,
    executor: Rc<dyn Executor>,
    segmenter: RefCell<Segmenter>,
    phrases: RefCell<Vec<String>>,
    decoding: RefCell<Chain>,
    /// Phrases cut so far: a live guess started before the latest cut is stale.
    cuts: Cell<usize>,
    queued: Cell<usize>,
    guessing: Cell<bool>,
    since_guess: Cell<usize>,
    guess_gap: Cell<usize>,
    last_guess: RefCell<Option<LastGuess>>,
    /// From key up; `released` once the mic's last audio is in.
    releasing: Cell<bool>,
    released: Cell<bool>,
    cancelled: Cell<bool>,
    error: RefCell<Option<String>>,
    /// Sound has reached this dictation (the mic is working).
    hearing: Cell<bool>,
}

impl Run {
    fn new(insertion: Rc<dyn DictationInsertion>, engine: Rc<dyn DictationEngine>, executor: Rc<dyn Executor>) -> Rc<Self> {
        Rc::new(Self {
            insertion,
            engine,
            executor,
            segmenter: RefCell::new(create_segmenter(DEFAULT_SEGMENTER)),
            phrases: RefCell::default(),
            decoding: RefCell::new(ready_chain()),
            cuts: Cell::new(0),
            queued: Cell::new(0),
            guessing: Cell::new(false),
            since_guess: Cell::new(0),
            guess_gap: Cell::new(LIVE_STEP_SAMPLES),
            last_guess: RefCell::new(None),
            releasing: Cell::new(false),
            released: Cell::new(false),
            cancelled: Cell::new(false),
            error: RefCell::new(None),
            hearing: Cell::new(false),
        })
    }

    fn open(&self) -> bool {
        !self.released.get() && !self.cancelled.get() && self.error.borrow().is_none()
    }

    /// Guesses stop at key up: the final decode is next.
    fn may_guess(&self) -> bool {
        self.open() && !self.releasing.get()
    }

    fn queue(&self, job: impl std::future::Future<Output = ()> + 'static) {
        let previous = self.decoding.borrow().clone();
        let next = async move {
            previous.await;
            job.await;
        }
        .boxed_local()
        .shared();
        self.executor.spawn(next.clone().boxed_local());
        *self.decoding.borrow_mut() = next;
    }

    /// A cut phrase; `preview: false` for the last one, committed next.
    fn decode_phrase(self: &Rc<Self>, samples: Vec<f32>, preview: bool) {
        self.cuts.set(self.cuts.get() + 1);
        self.queued.set(self.queued.get() + 1);
        let run = self.clone();
        self.queue(async move {
            if !run.cancelled.get() && run.error.borrow().is_none() {
                match run.engine.transcribe(samples).await {
                    Ok(text) if !run.cancelled.get() => {
                        run.phrases.borrow_mut().push(text.clone());
                        // The settled phrase takes the live guess's place in one update.
                        if preview && has_words(&text) {
                            let joined = join_phrases(&run.phrases.borrow());
                            run.insertion.preview(&joined);
                        }
                    }
                    Ok(_) => {}
                    Err(err) => *run.error.borrow_mut() = Some(format!("{err:#}")),
                }
            }
            run.queued.set(run.queued.get() - 1);
        });
    }

    /// The speaker has paused after words the last guess didn't hear.
    fn paused(&self) -> bool {
        let segmenter = self.segmenter.borrow();
        let heard = match &*self.last_guess.borrow() {
            Some(g) if g.at == self.cuts.get() => g.heard,
            _ => 0,
        };
        segmenter.quiet_ms() >= SETTLE_QUIET_MS && segmenter.speech_after(heard)
    }

    /// The phrase still being spoken, again from its start, when the engine is free.
    fn guess(self: &Rc<Self>) {
        if !self.may_guess() || self.guessing.get() || self.queued.get() > 0 {
            return;
        }
        if self.since_guess.get() < self.guess_gap.get() && !self.paused() {
            return;
        }
        let audio = {
            let segmenter = self.segmenter.borrow();
            let audio = segmenter.peek();
            if audio.len() < MIN_LIVE_SAMPLES || !segmenter.has_speech() {
                return;
            }
            audio
        };
        let at = self.cuts.get();
        self.since_guess.set(0);
        self.guessing.set(true);
        let run = self.clone();
        self.queue(async move {
            // A guess still waiting when the key comes up is skipped.
            if run.may_guess() {
                let started = Instant::now();
                let heard = audio.len();
                if let Ok(raw) = run.engine.transcribe(audio).await {
                    // The model ends whatever it hears with a period; mid-phrase
                    // that's only where the audio stopped so far.
                    let text = raw.strip_suffix('.').unwrap_or(&raw).to_string();
                    let took_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let gap = (SAMPLE_RATE as f64 * 1.5 * took_ms / 1000.0) as usize;
                    run.guess_gap.set(LIVE_STEP_SAMPLES.max(gap));
                    // Shown words are only ever replaced by other words: a guess
                    // that came back empty leaves the last one up.
                    if !run.cancelled.get() && run.cuts.get() == at && has_words(&text) {
                        *run.last_guess.borrow_mut() = Some(LastGuess { raw, heard, at });
                        if run.open() {
                            let mut all = run.phrases.borrow().clone();
                            all.push(text);
                            run.insertion.preview(&join_phrases(&all));
                        }
                    }
                }
                // A failed guess isn't a failed dictation: the phrase decode of
                // the same audio reports it if the model is really down.
            }
            run.guessing.set(false);
        });
    }

    fn hear(self: &Rc<Self>, samples: &[f32]) {
        if !self.open() {
            return;
        }
        self.since_guess.set(self.since_guess.get() + samples.len());
        let phrases = self.segmenter.borrow_mut().push(samples);
        for phrase in phrases {
            self.decode_phrase(phrase, true);
        }
        self.guess();
    }

    /// Decodes what's left and resolves with the whole text. When the last
    /// guess already heard all of the speech in the final phrase, it is that
    /// phrase: decoding the same audio again would only make the release wait.
    async fn finish(self: Rc<Self>) -> Result<String, String> {
        let decoding = self.decoding.borrow().clone();
        decoding.await;
        let cuts = self.cuts.get();
        let guessed = self.last_guess.borrow_mut().take().filter(|g| g.at == cuts);
        let (fresh, tail) = {
            let mut segmenter = self.segmenter.borrow_mut();
            let fresh = match &guessed {
                Some(g) => segmenter.speech_after(g.heard),
                None => segmenter.has_speech(),
            };
            (fresh, segmenter.flush())
        };
        match guessed {
            Some(g) if !fresh => self.phrases.borrow_mut().push(g.raw),
            _ if fresh && tail.len() >= MIN_TAIL_SAMPLES => self.decode_phrase(tail, false),
            _ => {}
        }
        let decoding = self.decoding.borrow().clone();
        decoding.await;
        if let Some(error) = self.error.borrow().clone() {
            return Err(error);
        }
        Ok(join_phrases(&self.phrases.borrow()))
    }
}

type MicFuture = Shared<LocalBoxFuture<'static, Result<Rc<dyn Microphone>, String>>>;

struct Inner {
    deps: DictationDeps,
    targets: RefCell<Vec<(u64, Rc<dyn DictationTarget>)>>,
    next_target: Cell<u64>,
    listeners: Listeners<()>,
    state: RefCell<DictationState>,
    run: RefCell<Option<Rc<Run>>>,
    opening: RefCell<Chain>,
    /// The mic being opened or open, with an id standing in for the TS's
    /// promise identity (`mic === pending`).
    mic: RefCell<Option<(u64, MicFuture)>>,
    next_mic: Cell<u64>,
    /// The mic once it has opened.
    mic_open: RefCell<Option<Rc<dyn Microphone>>>,
    /// Bumped to cancel a pending close (the TS `clearTimeout(micClose)`).
    mic_close: Cell<u64>,
    preroll: RefCell<VecDeque<Vec<f32>>>,
    level: Cell<f32>,
    /// The hold key is down (by its right-hand key).
    held: Cell<bool>,
}

/// The dictation service — `core.dictation`.
#[derive(Clone)]
pub struct DictationApi {
    inner: Rc<Inner>,
}

pub fn create_dictation(deps: DictationDeps) -> DictationApi {
    DictationApi {
        inner: Rc::new(Inner {
            deps,
            targets: RefCell::default(),
            next_target: Cell::new(0),
            listeners: Listeners::new(),
            state: RefCell::new(DictationState::idle()),
            run: RefCell::new(None),
            opening: RefCell::new(ready_chain()),
            mic: RefCell::new(None),
            next_mic: Cell::new(0),
            mic_open: RefCell::new(None),
            mic_close: Cell::new(0),
            preroll: RefCell::default(),
            level: Cell::new(0.0),
            held: Cell::new(false),
        }),
    }
}

fn same(a: &Rc<Run>, b: &Option<Rc<Run>>) -> bool {
    b.as_ref().is_some_and(|b| Rc::ptr_eq(a, b))
}

impl Inner {
    fn set_state(&self, next: DictationState) {
        *self.state.borrow_mut() = next;
        self.listeners.emit();
    }

    fn current_run(&self) -> Option<Rc<Run>> {
        self.run.borrow().clone()
    }

    fn close_mic(&self) {
        let closing = self.mic.borrow_mut().take();
        self.mic_open.borrow_mut().take();
        self.preroll.borrow_mut().clear();
        if let Some((_, closing)) = closing {
            self.deps.executor.spawn_local(async move {
                if let Ok(mic) = closing.await {
                    mic.close();
                }
            });
        }
    }

    fn on_audio(self: &Rc<Self>, samples: &[f32]) {
        if let Some(run) = self.current_run() {
            if !run.released.get() && !run.cancelled.get() {
                run.hearing.set(true);
                self.level.set(loudness(samples));
                run.hear(samples);
                return;
            }
        }
        let mut preroll = self.preroll.borrow_mut();
        preroll.push_back(samples.to_vec());
        let mut kept: usize = preroll.iter().map(Vec::len).sum();
        while preroll.len() > 1 && kept - preroll[0].len() >= PREROLL_SAMPLES {
            kept -= preroll.pop_front().map(|s| s.len()).unwrap_or(0);
        }
    }

    fn open_mic(self: &Rc<Self>) -> MicFuture {
        self.mic_close.set(self.mic_close.get() + 1);
        // A mic kept warm is reused only while it still works; one that went
        // quiet behind our back is replaced, not trusted.
        let stale = self.mic_open.borrow().as_ref().is_some_and(|m| !m.live());
        if stale {
            self.close_mic();
        }
        if let Some((_, mic)) = self.mic.borrow().clone() {
            return mic;
        }
        let id = self.next_mic.get() + 1;
        self.next_mic.set(id);
        let opening = (self.deps.open_microphone)();
        let weak = Rc::downgrade(self);
        let pending: MicFuture = async move {
            match opening.await {
                Ok(mic) => {
                    let audio = weak.clone();
                    mic.on_audio(Box::new(move |samples| {
                        if let Some(this) = audio.upgrade() {
                            this.on_audio(samples);
                        }
                    }))
                    // The mic's `close` lets its listeners go.
                    .detach();
                    if let Some(this) = weak.upgrade() {
                        if this.mic.borrow().as_ref().is_some_and(|(i, _)| *i == id) {
                            *this.mic_open.borrow_mut() = Some(mic.clone());
                        }
                    }
                    Ok(mic)
                }
                Err(err) => {
                    if let Some(this) = weak.upgrade() {
                        let mut slot = this.mic.borrow_mut();
                        if slot.as_ref().is_some_and(|(i, _)| *i == id) {
                            *slot = None;
                        }
                    }
                    Err(format!("{err:#}"))
                }
            }
        }
        .boxed_local()
        .shared();
        *self.mic.borrow_mut() = Some((id, pending.clone()));
        let drive = pending.clone();
        self.deps.executor.spawn_local(async move {
            let _ = drive.await;
        });
        pending
    }

    /// Closes the mic once it has gone unused for `warm` — never under a
    /// dictation in progress.
    fn close_later(self: &Rc<Self>) {
        let generation = self.mic_close.get() + 1;
        self.mic_close.set(generation);
        let timer = self.deps.executor.timer(self.deps.warm);
        let weak = Rc::downgrade(self);
        self.deps.executor.spawn_local(async move {
            timer.await;
            if let Some(this) = weak.upgrade() {
                if this.mic_close.get() == generation && this.run.borrow().is_none() {
                    this.close_mic();
                }
            }
        });
    }

    /// Everything the mic heard up to now, in: its last batch may still be
    /// on its way when the key comes up.
    fn flush_mic(&self) -> LocalBoxFuture<'static, ()> {
        let mic = self.mic.borrow().as_ref().map(|(_, m)| m.clone());
        let executor = self.deps.executor.clone();
        async move {
            let Some(mic) = mic else { return };
            if let Ok(mic) = mic.await {
                let budget = executor.timer(FLUSH_BUDGET);
                futures::future::select(mic.flush(), budget).await;
            }
        }
        .boxed_local()
    }

    /// Ends `current`, if it's still the dictation in progress.
    fn end(self: &Rc<Self>, current: &Rc<Run>, error: Option<String>) {
        if !same(current, &self.run.borrow()) {
            return;
        }
        self.run.borrow_mut().take();
        self.level.set(0.0);
        match error {
            None => {
                self.close_later();
                self.set_state(DictationState::idle());
            }
            Some(error) => {
                current.insertion.cancel();
                self.close_mic();
                self.set_state(DictationState { status: DictationStatus::Error, error: Some(error) });
            }
        }
    }

    async fn start(self: Rc<Self>, current: Rc<Run>) {
        let enabled = (self.deps.enabled)().await;
        // Cancelled meanwhile: `end` already ran, and no mic is open.
        if current.cancelled.get() {
            return;
        }
        if !enabled {
            current.cancelled.set(true);
            current.insertion.cancel();
            return self.end(&current, None);
        }
        // The model loads alongside the mic; the first decode waits for it.
        let load = self.deps.engine.load();
        self.deps.executor.spawn_local(async move {
            let _ = load.await;
        });
        if let Err(error) = self.open_mic().await {
            return self.end(&current, Some(error));
        }
        // Cancelled while it opened: opening cleared the close `end` set up
        // (unless a newer dictation has the mic now).
        if current.cancelled.get() {
            if self.run.borrow().is_none() {
                self.close_later();
            }
            return;
        }
        let heard: Vec<Vec<f32>> = self.preroll.borrow_mut().drain(..).collect();
        for samples in heard {
            self.on_audio(&samples);
        }
        if !current.released.get() {
            self.set_state(DictationState::with(DictationStatus::Listening));
        }
        // Saying nothing is fine; a mic that sends nothing at all is not, and
        // must say so rather than leave the speaker talking to no one.
        let timer = self.deps.executor.timer(NO_SOUND);
        let weak: Weak<Inner> = Rc::downgrade(&self);
        self.deps.executor.spawn_local(async move {
            timer.await;
            let Some(this) = weak.upgrade() else { return };
            if same(&current, &this.run.borrow()) && !current.hearing.get() && !current.cancelled.get() {
                this.end(&current, Some(NO_SOUND_ERROR.to_string()));
            }
        });
    }
}

impl DictationApi {
    pub fn hold_key(&self) -> DictationHoldKey {
        self.inner.deps.hold_key
    }

    pub fn state(&self) -> DictationState {
        self.inner.state.borrow().clone()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.listeners.subscribe(move |_| listener())
    }

    /// An editor offers itself; dropping the subscription detaches it.
    pub fn attach(&self, target: Rc<dyn DictationTarget>) -> Subscription {
        let id = self.inner.next_target.get() + 1;
        self.inner.next_target.set(id);
        self.inner.targets.borrow_mut().push((id, target));
        let weak = Rc::downgrade(&self.inner);
        Subscription::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.targets.borrow_mut().retain(|(i, _)| *i != id);
            }
        })
    }

    /// The mic's level now, 0–1 (for the wave).
    pub fn level(&self) -> f32 {
        self.inner.level.get()
    }

    /// Whether sound is reaching it yet: a mic takes a moment to open.
    pub fn hearing(&self) -> bool {
        self.inner.current_run().is_some_and(|r| r.hearing.get() && !r.released.get())
    }

    /// Key down: starts listening into the focused attached editor, if any.
    /// Like the TS async function, everything up to the first wait happens
    /// on the call; the returned future is the rest.
    pub fn press(&self) -> LocalBoxFuture<'static, ()> {
        let inner = self.inner.clone();
        if inner.run.borrow().is_some() {
            return futures::future::ready(()).boxed_local();
        }
        let targets: Vec<_> = inner.targets.borrow().iter().map(|(_, t)| t.clone()).collect();
        let Some(insertion) = targets.iter().find(|t| t.has_focus()).and_then(|t| t.begin()) else {
            return futures::future::ready(()).boxed_local();
        };
        let current = Run::new(insertion, inner.deps.engine.clone(), inner.deps.executor.clone());
        *inner.run.borrow_mut() = Some(current.clone());
        inner.set_state(DictationState::with(DictationStatus::Starting));
        let opening = inner.clone().start(current).boxed_local().shared();
        inner.deps.executor.spawn(opening.clone().boxed_local());
        *inner.opening.borrow_mut() = opening.clone();
        opening.boxed_local()
    }

    /// Key up: decodes what's left and inserts the text. Marks the
    /// dictation as releasing on the call (a live guess still queued is
    /// skipped), as the TS did before its first wait.
    pub fn release(&self) -> LocalBoxFuture<'static, ()> {
        let inner = self.inner.clone();
        let Some(current) = inner.current_run() else { return futures::future::ready(()).boxed_local() };
        if current.releasing.get() || current.cancelled.get() {
            return futures::future::ready(()).boxed_local();
        }
        current.releasing.set(true);
        inner.set_state(DictationState::with(DictationStatus::Finishing));
        async move {
            let opening = inner.opening.borrow().clone();
            opening.await;
            if !same(&current, &inner.run.borrow()) || current.cancelled.get() {
                return;
            }
            inner.flush_mic().await;
            current.released.set(true);
            inner.level.set(0.0);
            match current.clone().finish().await {
                Ok(text) => {
                    if current.cancelled.get() {
                        return;
                    }
                    current.insertion.commit(&text);
                    inner.end(&current, None);
                    if !text.is_empty() {
                        if let Some(on_dictated) = &inner.deps.on_dictated {
                            on_dictated();
                        }
                    }
                }
                Err(error) => inner.end(&current, Some(error)),
            }
        }
        .boxed_local()
    }

    /// Escape: drops this dictation; nothing is inserted.
    pub fn cancel(&self) {
        let Some(current) = self.inner.current_run() else { return };
        current.cancelled.set(true);
        current.insertion.cancel();
        self.inner.end(&current, None);
    }

    /// Loads the model ahead of the first press; resolves once it's ready.
    pub fn warm(&self) -> LocalBoxFuture<'static, ()> {
        let load = self.inner.deps.engine.load();
        async move {
            let _ = load.await;
        }
        .boxed_local()
    }

    /// The TS `listen()`'s key handling, fed by the platform's key monitor
    /// (GPUI can't tell left from right modifiers): held is "the modifier is
    /// down, by its right-hand key". Starts or ends a dictation on the
    /// executor.
    pub fn modifier_changed(&self, key: ModifierKey, down: bool) {
        let ours = matches!(
            (self.hold_key(), key),
            (DictationHoldKey::ControlRight, ModifierKey::ControlRight) | (DictationHoldKey::AltRight, ModifierKey::AltRight)
        );
        if !ours || self.inner.held.get() == down {
            return;
        }
        self.inner.held.set(down);
        let step = if down { self.press() } else { self.release() };
        self.inner.deps.executor.spawn(step);
    }

    /// The window lost focus: the key tracker lets go of everything.
    pub fn keys_released(&self) {
        if self.inner.held.replace(false) {
            self.inner.deps.executor.spawn(self.release());
        }
    }

    /// Escape, seen before anything else handles it: cancels a dictation in
    /// progress. Returns whether it did, so the caller swallows the key (a
    /// composer's own Escape would stop a running agent turn).
    pub fn escape(&self) -> bool {
        if self.inner.run.borrow().is_none() {
            return false;
        }
        self.cancel();
        true
    }

    /// The app went out of sight: the mic is let go — nobody dictates into a
    /// hidden app, and audio kept open there is what the OS interrupts.
    pub fn app_hidden(&self) {
        if self.inner.run.borrow().is_none() {
            self.inner.close_mic();
        }
    }

    /// The TS `listen()` teardown: cancels, stops the warm timer, closes the mic.
    pub fn stop(&self) {
        self.cancel();
        self.inner.mic_close.set(self.inner.mic_close.get() + 1);
        self.inner.close_mic();
    }
}
