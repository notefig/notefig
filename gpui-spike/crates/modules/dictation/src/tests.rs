//! Port of `packages/dictation/src/{dictation,target}.test.ts` and
//! `engine/{engine,worker-engine}.test.ts`, over `TestExecutor`: the TS
//! `vi.waitFor` is `run_until_parked`, fake timers are `advance`.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services, Subscription};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;

use crate::engine::ctc::{greedy_ctc, parse_tokens};
use crate::engine::load_model::{load_bundled_model, sha256_hex};
use crate::engine::log_mel::{PARAKEET_FEATURES, create_fft, create_log_mel};
use crate::*;

const RATE: usize = 16_000;

fn speech(ms: usize) -> Vec<f32> {
    (0..RATE * ms / 1000).map(|i| 0.2 * (i as f32 * 0.3).sin()).collect()
}
fn silence(ms: usize) -> Vec<f32> {
    vec![0.0; RATE * ms / 1000]
}
/// Short phrases, for segmenter tests that shouldn't need minutes of audio.
const SHORT: SegmenterOptions = SegmenterOptions { sample_rate: 16_000, pause_ms: 400, min_phrase_ms: 2000, max_phrase_ms: 5000 };

// ─── fakes ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct FakeMic {
    listener: RefCell<Option<Box<dyn Fn(&[f32])>>>,
    closed: Cell<bool>,
    broken: Cell<bool>,
    on_flush: RefCell<Option<Box<dyn Fn()>>>,
}

impl FakeMic {
    fn say(&self, samples: &[f32]) {
        if let Some(listener) = &*self.listener.borrow() {
            listener(samples);
        }
    }
}

impl Microphone for FakeMic {
    fn on_audio(&self, listener: Box<dyn Fn(&[f32])>) -> Subscription {
        *self.listener.borrow_mut() = Some(listener);
        Subscription::none()
    }
    fn flush(&self) -> LocalBoxFuture<'static, ()> {
        if let Some(hook) = &*self.on_flush.borrow() {
            hook();
        }
        futures::future::ready(()).boxed_local()
    }
    fn live(&self) -> bool {
        !self.broken.get() && !self.closed.get()
    }
    fn close(&self) {
        self.closed.set(true);
        self.listener.borrow_mut().take();
    }
}

type Reply = Box<dyn FnOnce(&[f32]) -> LocalBoxFuture<'static, anyhow::Result<String>>>;

#[derive(Default)]
struct FakeEngine {
    loads: Cell<usize>,
    calls: Cell<usize>,
    once: RefCell<VecDeque<Reply>>,
    default: RefCell<Option<Rc<dyn Fn(&[f32]) -> anyhow::Result<String>>>>,
}

impl FakeEngine {
    fn always(&self, f: impl Fn(&[f32]) -> anyhow::Result<String> + 'static) {
        *self.default.borrow_mut() = Some(Rc::new(f));
    }
    fn once(&self, reply: Reply) {
        self.once.borrow_mut().push_back(reply);
    }
    fn once_text(&self, text: &'static str) {
        self.once(Box::new(move |_| futures::future::ready(Ok(text.to_string())).boxed_local()));
    }
}

impl DictationEngine for FakeEngine {
    fn load(&self) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        self.loads.set(self.loads.get() + 1);
        futures::future::ready(Ok(())).boxed_local()
    }
    fn transcribe(&self, samples: Vec<f32>) -> LocalBoxFuture<'static, anyhow::Result<String>> {
        self.calls.set(self.calls.get() + 1);
        if let Some(reply) = self.once.borrow_mut().pop_front() {
            return reply(&samples);
        }
        let result = match &*self.default.borrow() {
            Some(f) => f(&samples),
            None => Ok(String::new()),
        };
        futures::future::ready(result).boxed_local()
    }
}

struct FakeTarget {
    focused: bool,
    events: Rc<RefCell<Vec<String>>>,
}

struct FakeInsertion(Rc<RefCell<Vec<String>>>);

impl DictationInsertion for FakeInsertion {
    fn preview(&self, text: &str) {
        self.0.borrow_mut().push(format!("preview:{text}"));
    }
    fn commit(&self, text: &str) {
        self.0.borrow_mut().push(format!("commit:{text}"));
    }
    fn cancel(&self) {
        self.0.borrow_mut().push("cancel".into());
    }
}

impl DictationTarget for FakeTarget {
    fn has_focus(&self) -> bool {
        self.focused
    }
    fn begin(&self) -> Option<Rc<dyn DictationInsertion>> {
        Some(Rc::new(FakeInsertion(self.events.clone())))
    }
}

fn target(focused: bool) -> (Rc<dyn DictationTarget>, Rc<RefCell<Vec<String>>>) {
    let events = Rc::new(RefCell::new(Vec::new()));
    (Rc::new(FakeTarget { focused, events: events.clone() }), events)
}

fn last(events: &Rc<RefCell<Vec<String>>>) -> String {
    events.borrow().last().cloned().unwrap_or_default()
}
fn has(events: &Rc<RefCell<Vec<String>>>, event: &str) -> bool {
    events.borrow().iter().any(|e| e == event)
}

struct Setup {
    exec: Rc<TestExecutor>,
    engine: Rc<FakeEngine>,
    mic: Rc<FakeMic>,
    enabled: Rc<Cell<bool>>,
    dictated: Rc<Cell<usize>>,
    dictation: DictationApi,
}

fn deps(exec: &Rc<TestExecutor>, engine: &Rc<FakeEngine>, open: OpenMicrophone) -> DictationDeps {
    DictationDeps {
        engine: engine.clone(),
        open_microphone: open,
        enabled: Rc::new(|| futures::future::ready(true).boxed_local()),
        on_dictated: None,
        hold_key: DictationHoldKey::ControlRight,
        warm: Duration::from_secs(30),
        executor: exec.clone(),
    }
}

fn mic_opener(mic: &Rc<FakeMic>) -> OpenMicrophone {
    let mic = mic.clone();
    Rc::new(move || futures::future::ready(Ok(mic.clone() as Rc<dyn Microphone>)).boxed_local())
}

fn setup() -> Setup {
    let exec = TestExecutor::new();
    let engine = Rc::new(FakeEngine::default());
    let mic = Rc::new(FakeMic::default());
    let enabled = Rc::new(Cell::new(true));
    let dictated = Rc::new(Cell::new(0));
    let (on, count) = (enabled.clone(), dictated.clone());
    let dictation = create_dictation(DictationDeps {
        enabled: Rc::new(move || futures::future::ready(on.get()).boxed_local()),
        on_dictated: Some(Rc::new(move || count.set(count.get() + 1))),
        warm: Duration::from_millis(50),
        ..deps(&exec, &engine, mic_opener(&mic))
    });
    Setup { exec, engine, mic, enabled, dictated, dictation }
}

fn status(d: &DictationApi) -> DictationStatus {
    d.state().status
}

// ─── dictation ─────────────────────────────────────────────────────────────

#[test]
fn inserts_what_was_said_into_the_focused_editor_on_release() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.once_text("Ship it.");
    s.exec.block_on(s.dictation.press());
    assert_eq!(status(&s.dictation), DictationStatus::Listening);
    s.mic.say(&speech(1000));
    s.exec.block_on(s.dictation.release());
    assert_eq!(last(&events), "commit:Ship it.");
    assert_eq!(s.dictated.get(), 1);
    assert_eq!(status(&s.dictation), DictationStatus::Idle);
}

#[test]
fn decodes_phrases_at_pauses_while_talking_and_joins_them_on_release() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    let cut = Rc::new(Cell::new(false));
    s.engine.always(move |samples| {
        if !cut.get() && samples.len() as f32 > 4.6 * RATE as f32 {
            cut.set(true);
            return Ok("We should refactor".into());
        }
        Ok(if cut.get() { "The extension." } else { "We should" }.into())
    });
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(4500));
    s.mic.say(&silence(700));
    s.exec.run_until_parked();
    assert!(has(&events, "preview:We should refactor"), "{:?}", events.borrow());
    s.mic.say(&speech(1500));
    s.exec.block_on(s.dictation.release());
    assert_eq!(last(&events), "commit:We should refactor the extension.");
}

#[test]
fn streams_the_phrase_being_spoken_as_live_text_before_it_settles() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.always(|samples| Ok(if samples.len() < RATE { "We" } else { "We should" }.into()));
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(600));
    s.exec.run_until_parked();
    assert!(has(&events, "preview:We"));
    s.mic.say(&speech(600));
    s.exec.run_until_parked();
    assert!(has(&events, "preview:We should"));
    s.exec.block_on(s.dictation.release());
    assert_eq!(last(&events), "commit:We should");
}

#[test]
fn keeps_the_shown_words_when_a_guess_comes_back_empty() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    for g in ["We", "", ".", "We should"] {
        s.engine.once_text(g);
    }
    s.engine.always(|_| Ok("We should".into()));
    s.exec.block_on(s.dictation.press());
    for i in 0..4 {
        s.mic.say(&speech(300));
        s.exec.run_until_parked();
        assert_eq!(s.engine.calls.get(), i + 1);
    }
    let previews: Vec<String> = events.borrow().iter().filter(|e| e.starts_with("preview:")).cloned().collect();
    assert_eq!(previews, ["preview:We", "preview:We should"]);
    s.dictation.cancel();
}

#[test]
fn lets_go_straight_to_the_last_guess_when_nothing_was_said_after_it() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.always(|_| Ok("Ship it.".into()));
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(1000));
    s.exec.run_until_parked();
    assert!(has(&events, "preview:Ship it"));
    s.mic.say(&silence(300));
    let calls = s.engine.calls.get();
    s.exec.block_on(s.dictation.release());
    // No second decode of the same speech: the guess, as the model wrote it.
    assert_eq!(s.engine.calls.get(), calls);
    assert_eq!(last(&events), "commit:Ship it.");
}

#[test]
fn decodes_the_rest_on_release_when_there_was_speech_after_the_last_guess() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.always(|samples| Ok(if samples.len() as f32 > 1.5 * RATE as f32 { "Ship it today." } else { "Ship it" }.into()));
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(1000));
    s.exec.run_until_parked();
    assert!(has(&events, "preview:Ship it"));
    // Too soon for another guess, so only the release hears these words.
    s.mic.say(&speech(150));
    s.mic.say(&speech(700));
    s.exec.block_on(s.dictation.release());
    assert_eq!(last(&events), "commit:Ship it today.");
}

#[test]
fn drops_a_live_guess_that_a_phrase_cut_has_overtaken() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    let (finish_live, live) = oneshot::channel::<String>();
    let live = RefCell::new(Some(live));
    s.engine.once(Box::new(move |_| {
        let rx = live.borrow_mut().take().unwrap();
        async move { Ok(rx.await.unwrap()) }.boxed_local()
    }));
    s.engine.once_text("Settled phrase.");
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(4500));
    s.exec.run_until_parked();
    assert_eq!(s.engine.calls.get(), 1);
    s.mic.say(&silence(700));
    finish_live.send("stale guess".into()).unwrap();
    s.exec.block_on(s.dictation.release());
    assert!(!has(&events, "preview:stale guess"));
    assert_eq!(last(&events), "commit:Settled phrase.");
}

#[test]
fn reports_the_mics_loudness_while_listening_and_silence_after() {
    let s = setup();
    let (t, _events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    s.mic.say(&silence(100));
    assert_eq!(s.dictation.level(), 0.0);
    s.mic.say(&speech(100));
    assert!(s.dictation.level() > 0.5);
    s.exec.block_on(s.dictation.release());
    assert_eq!(s.dictation.level(), 0.0);
}

#[test]
fn does_nothing_when_no_attached_editor_has_focus() {
    let s = setup();
    let (t, events) = target(false);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    assert_eq!(status(&s.dictation), DictationStatus::Idle);
    assert!(events.borrow().is_empty());
}

#[test]
fn stops_offering_an_editor_once_it_detaches() {
    let s = setup();
    let (t, events) = target(true);
    drop(s.dictation.attach(t));
    s.exec.block_on(s.dictation.press());
    assert!(events.borrow().is_empty());
}

#[test]
fn drops_the_dictation_on_cancel() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.once_text("never mind");
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(300));
    s.dictation.cancel();
    s.exec.block_on(s.dictation.release());
    assert_eq!(*events.borrow(), ["cancel"]);
    assert_eq!(s.engine.calls.get(), 0);
}

#[test]
fn is_a_no_op_while_the_setting_is_off() {
    let s = setup();
    s.enabled.set(false);
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    assert_eq!(*events.borrow(), ["cancel"]);
    assert_eq!(status(&s.dictation), DictationStatus::Idle);
}

#[test]
fn reports_a_refused_microphone_and_recovers_on_the_next_press() {
    let exec = TestExecutor::new();
    let engine = Rc::new(FakeEngine::default());
    let mic = Rc::new(FakeMic::default());
    let refuse = Rc::new(Cell::new(true));
    let (r, m) = (refuse.clone(), mic.clone());
    let dictation = create_dictation(deps(
        &exec,
        &engine,
        Rc::new(move || {
            let result = if r.get() { Err(anyhow::anyhow!("Permission denied")) } else { Ok(m.clone() as Rc<dyn Microphone>) };
            futures::future::ready(result).boxed_local()
        }),
    ));
    let (t, events) = target(true);
    let _a = dictation.attach(t);
    exec.block_on(dictation.press());
    assert_eq!(dictation.state(), DictationState { status: DictationStatus::Error, error: Some("Permission denied".into()) });
    assert_eq!(*events.borrow(), ["cancel"]);
    refuse.set(false);
    exec.block_on(dictation.press());
    assert_eq!(status(&dictation), DictationStatus::Listening);
}

#[test]
fn cancels_instead_of_inserting_when_the_model_fails() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.once(Box::new(|_| futures::future::ready(Err(anyhow::anyhow!("model failed"))).boxed_local()));
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(1000));
    s.exec.block_on(s.dictation.release());
    assert_eq!(*events.borrow(), ["cancel"]);
    assert_eq!(s.dictation.state(), DictationState { status: DictationStatus::Error, error: Some("model failed".into()) });
}

#[test]
fn closes_the_mic_when_a_dictation_is_cancelled_while_it_starts() {
    let exec = TestExecutor::new();
    let engine = Rc::new(FakeEngine::default());
    let mic = Rc::new(FakeMic::default());
    let opened = Rc::new(Cell::new(0));
    let (setting_read, setting) = oneshot::channel::<bool>();
    let setting = Rc::new(RefCell::new(Some(setting)));
    let (o, m) = (opened.clone(), mic.clone());
    let dictation = create_dictation(DictationDeps {
        enabled: Rc::new(move || {
            let rx = setting.borrow_mut().take().unwrap();
            async move { rx.await.unwrap_or(false) }.boxed_local()
        }),
        warm: Duration::from_millis(50),
        ..deps(
            &exec,
            &engine,
            Rc::new(move || {
                o.set(o.get() + 1);
                futures::future::ready(Ok(m.clone() as Rc<dyn Microphone>)).boxed_local()
            }),
        )
    });
    let (t, _events) = target(true);
    let _a = dictation.attach(t);
    exec.spawn_local_test(dictation.press());
    dictation.cancel();
    setting_read.send(true).unwrap();
    exec.advance(Duration::from_millis(60));
    // Never opened, or opened and closed again: not left open.
    assert!(opened.get() == 0 || mic.closed.get());
    assert_eq!(status(&dictation), DictationStatus::Idle);
}

#[test]
fn keeps_the_mic_for_a_dictation_started_while_a_cancelled_one_was_opening_it() {
    let exec = TestExecutor::new();
    let engine = Rc::new(FakeEngine::default());
    let mic = Rc::new(FakeMic::default());
    let opens: Rc<RefCell<Vec<oneshot::Sender<()>>>> = Rc::default();
    let (o, m) = (opens.clone(), mic.clone());
    let dictation = create_dictation(DictationDeps {
        warm: Duration::from_millis(50),
        ..deps(
            &exec,
            &engine,
            Rc::new(move || {
                let (tx, rx) = oneshot::channel();
                o.borrow_mut().push(tx);
                let m = m.clone();
                async move {
                    let _ = rx.await;
                    Ok(m as Rc<dyn Microphone>)
                }
                .boxed_local()
            }),
        )
    });
    let (t, _events) = target(true);
    let _a = dictation.attach(t);
    exec.spawn_local_test(dictation.press());
    exec.run_until_parked();
    dictation.cancel();
    exec.spawn_local_test(dictation.press());
    exec.run_until_parked();
    for open in opens.borrow_mut().drain(..) {
        let _ = open.send(());
    }
    exec.advance(Duration::from_millis(200));
    assert_eq!(status(&dictation), DictationStatus::Listening);
    assert!(!mic.closed.get());
    dictation.cancel();
}

#[test]
fn waits_for_the_mics_last_batch_before_finishing() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.always(|samples| Ok(if samples.len() as f32 > 0.9 * RATE as f32 { "Every word." } else { "Every" }.into()));
    let weak = Rc::downgrade(&s.mic);
    *s.mic.on_flush.borrow_mut() = Some(Box::new(move || {
        if let Some(mic) = weak.upgrade() {
            mic.say(&speech(500));
        }
    }));
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(600));
    s.exec.block_on(s.dictation.release());
    assert_eq!(last(&events), "commit:Every word.");
}

#[test]
fn keeps_the_mic_warm_briefly_after_a_dictation_then_closes_it() {
    let s = setup();
    let (t, _events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    s.exec.block_on(s.dictation.release());
    assert!(!s.mic.closed.get());
    s.exec.advance(Duration::from_millis(60));
    assert!(s.mic.closed.get());
}

#[test]
fn opens_a_fresh_mic_when_the_warm_one_stopped_working() {
    let exec = TestExecutor::new();
    let engine = Rc::new(FakeEngine::default());
    let opened = Rc::new(Cell::new(0));
    let current: Rc<RefCell<Rc<FakeMic>>> = Rc::new(RefCell::new(Rc::new(FakeMic::default())));
    let (o, c) = (opened.clone(), current.clone());
    let dictation = create_dictation(deps(
        &exec,
        &engine,
        Rc::new(move || {
            o.set(o.get() + 1);
            let mic = Rc::new(FakeMic::default());
            *c.borrow_mut() = mic.clone();
            futures::future::ready(Ok(mic as Rc<dyn Microphone>)).boxed_local()
        }),
    ));
    let (t, events) = target(true);
    let _a = dictation.attach(t);
    exec.block_on(dictation.press());
    current.borrow().say(&speech(500));
    exec.block_on(dictation.release());
    assert_eq!(opened.get(), 1);

    // Interrupted while the app was in the background.
    let stale = current.borrow().clone();
    stale.broken.set(true);
    engine.once_text("Again.");
    exec.block_on(dictation.press());
    assert_eq!(opened.get(), 2);
    exec.run_until_parked();
    assert!(stale.closed.get());
    current.borrow().clone().say(&speech(1000));
    exec.block_on(dictation.release());
    assert_eq!(last(&events), "commit:Again.");
}

#[test]
fn says_so_when_the_mic_sends_no_sound_at_all() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    assert!(!s.dictation.hearing());
    s.exec.advance(Duration::from_millis(1600));
    assert_eq!(s.dictation.state(), DictationState { status: DictationStatus::Error, error: Some(NO_SOUND_ERROR.into()) });
    assert_eq!(*events.borrow(), ["cancel"]);
    assert!(s.mic.closed.get());
}

#[test]
fn is_hearing_once_sound_arrives_and_the_watchdog_stands_down() {
    let s = setup();
    let (t, _events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    s.mic.say(&vec![0.0; 640]);
    assert!(s.dictation.hearing());
    s.exec.advance(Duration::from_millis(1600));
    assert_eq!(status(&s.dictation), DictationStatus::Listening);
    s.exec.block_on(s.dictation.release());
    assert!(!s.dictation.hearing());
}

#[test]
fn lets_go_of_the_warm_mic_when_the_app_is_hidden() {
    let s = setup();
    let (t, _events) = target(true);
    let _a = s.dictation.attach(t);
    s.exec.block_on(s.dictation.press());
    s.mic.say(&speech(500));
    s.exec.block_on(s.dictation.release());
    assert!(!s.mic.closed.get());
    s.dictation.app_hidden();
    s.exec.run_until_parked();
    assert!(s.mic.closed.get());
}

#[test]
fn follows_the_right_hand_hold_key_down_up_and_escape() {
    let s = setup();
    let (t, events) = target(true);
    let _a = s.dictation.attach(t);
    s.engine.once_text("Hello.");
    // The left-hand Ctrl is just Ctrl.
    s.dictation.modifier_changed(ModifierKey::ControlLeft, true);
    s.exec.run_until_parked();
    assert_eq!(status(&s.dictation), DictationStatus::Idle);
    s.dictation.modifier_changed(ModifierKey::ControlLeft, false);

    s.dictation.modifier_changed(ModifierKey::ControlRight, true);
    s.exec.run_until_parked();
    assert_eq!(status(&s.dictation), DictationStatus::Listening);
    s.mic.say(&speech(1000));
    s.dictation.modifier_changed(ModifierKey::ControlRight, false);
    s.exec.run_until_parked();
    assert_eq!(last(&events), "commit:Hello.");

    s.dictation.modifier_changed(ModifierKey::ControlRight, true);
    s.exec.run_until_parked();
    assert_eq!(status(&s.dictation), DictationStatus::Listening);
    assert!(s.dictation.escape());
    assert_eq!(last(&events), "cancel");
    s.dictation.modifier_changed(ModifierKey::ControlRight, false);
    s.exec.run_until_parked();
    assert!(!s.dictation.escape(), "Escape passes through with no dictation");
}

#[test]
fn hold_key_is_right_option_on_macos_and_right_ctrl_elsewhere() {
    assert_eq!(dictation_hold_key(KeyPlatform::Mac), DictationHoldKey::AltRight);
    assert_eq!(dictation_hold_key(KeyPlatform::Windows), DictationHoldKey::ControlRight);
    assert_eq!(dictation_hold_key(KeyPlatform::Linux), DictationHoldKey::ControlRight);
    assert_eq!(hold_key_label(DictationHoldKey::AltRight, KeyPlatform::Mac), "right ⌥");
    assert_eq!(hold_key_label(DictationHoldKey::ControlRight, KeyPlatform::Windows), "right Ctrl");
}

// ─── joinPhrases ───────────────────────────────────────────────────────────

#[test]
fn joins_phrases_into_one_sentence_where_no_sentence_ended() {
    assert_eq!(join_phrases(&["So the plan", "Is to ship.", "Then rest."]), "So the plan is to ship. Then rest.");
}

#[test]
fn drops_the_period_a_cut_left_mid_sentence() {
    assert_eq!(
        join_phrases(&["We want it to feel instant.", "which means fast."]),
        "We want it to feel instant which means fast."
    );
}

#[test]
fn drops_a_phrase_that_is_only_punctuation() {
    assert_eq!(join_phrases(&["Ship it today.", "."]), "Ship it today.");
}

// ─── segmenter ─────────────────────────────────────────────────────────────

fn secs(samples: usize) -> f32 {
    samples as f32 / RATE as f32
}

#[test]
fn segmenter_cuts_a_phrase_in_the_middle_of_a_long_enough_pause() {
    let mut s = create_segmenter(SHORT);
    assert!(s.push(&speech(2500)).is_empty());
    let phrases = s.push(&silence(500));
    assert!((secs(phrases[0].len()) - 2.7).abs() < 0.05);
    // The pause's second half plus the 100 ms heard after the cut.
    assert!((secs(s.flush().len()) - 0.3).abs() < 0.05);
}

#[test]
fn segmenter_doesnt_decode_a_silent_tail_after_the_last_phrase() {
    let mut s = create_segmenter(SHORT);
    s.push(&speech(2500));
    s.push(&silence(500));
    assert!(!s.has_speech());
    s.push(&speech(300));
    assert!(s.has_speech());
}

#[test]
fn segmenter_doesnt_cut_a_short_phrase_or_silence_alone() {
    let mut s = create_segmenter(SHORT);
    assert!(s.push(&speech(800)).is_empty());
    assert!(s.push(&silence(600)).is_empty());
    let mut quiet = create_segmenter(SHORT);
    assert!(quiet.push(&silence(3000)).is_empty());
}

#[test]
fn segmenter_lets_a_long_silence_go_at_the_limit() {
    let mut s = create_segmenter(SHORT);
    assert!(s.push(&silence(6000)).is_empty());
    assert!(!s.has_speech());
    assert!(secs(s.peek().len()) < 2.0);
}

#[test]
fn segmenter_cuts_a_phrase_past_the_limit_at_its_quietest_recent_moment() {
    let mut s = create_segmenter(SHORT);
    // A 100 ms dip between "words" 4 s in, too short to be a pause.
    assert!(s.push(&speech(4000)).is_empty());
    assert!(s.push(&silence(100)).is_empty());
    let phrases = s.push(&speech(1000));
    // Cut inside the dip, not at the 5 s mark mid-"word".
    let len = secs(phrases[0].len());
    assert!((4.0..=4.1).contains(&len), "{len}");
}

// ─── resampler ─────────────────────────────────────────────────────────────

#[test]
fn resampler_turns_48k_into_16k_across_frame_boundaries() {
    let mut r = create_resampler(48_000, TARGET_RATE);
    let out = [r.resample(&[0.5; 128]), r.resample(&[0.5; 128])];
    assert_eq!(out[0].len() + out[1].len(), 256 / 3);
    assert!((out[1][0] - 0.5).abs() < 1e-6);
}

#[test]
fn resampler_handles_frames_of_any_size() {
    let mut r = create_resampler(48_000, TARGET_RATE);
    assert_eq!(r.resample(&vec![0.0; 4096]).len() + r.resample(&[0.0]).len(), 1365);
}

#[test]
fn resampler_handles_44_1k() {
    let mut r = create_resampler(44_100, TARGET_RATE);
    assert!(r.resample(&vec![0.0; 44_100]).len() >= 15_999);
}

// ─── fitDictation ──────────────────────────────────────────────────────────

#[test]
fn fit_starts_a_sentence_as_spoken_at_the_start_of_a_block() {
    assert_eq!(fit_dictation("", "", "Hello there."), "Hello there.");
}

#[test]
fn fit_adds_a_space_after_a_previous_sentence() {
    assert_eq!(fit_dictation("Done.", "", "Next one."), " Next one.");
}

#[test]
fn fit_lowercases_the_first_word_mid_sentence_but_keeps_i() {
    assert_eq!(fit_dictation("We should ", "", "Ship it."), "ship it.");
    assert_eq!(fit_dictation("and then ", "", "I left."), "I left.");
}

#[test]
fn fit_drops_the_closing_period_and_adds_a_space_before_a_following_word() {
    assert_eq!(fit_dictation("We ", "will see", "Really"), "really ");
    assert_eq!(fit_dictation("We ", "will see", "Really."), "really ");
}

#[test]
fn fit_inserts_nothing_for_silence() {
    assert_eq!(fit_dictation("x", "y", "  "), "");
}

// ─── engine: log-mel, ctc, model ───────────────────────────────────────────

fn naive_power_spectrum(frame: &[f32]) -> Vec<f32> {
    let n = frame.len();
    (0..=n / 2)
        .map(|k| {
            let (mut re, mut im) = (0f64, 0f64);
            for (i, x) in frame.iter().enumerate() {
                let a = 2.0 * std::f64::consts::PI * (k * i) as f64 / n as f64;
                re += *x as f64 * a.cos();
                im -= *x as f64 * a.sin();
            }
            (re * re + im * im) as f32
        })
        .collect()
}

#[test]
fn log_mel_computes_the_same_power_spectrum_as_a_naive_dft() {
    let mut fft = create_fft(512).unwrap();
    let frame: Vec<f32> = (0..512).map(|i| (i as f32 * 0.37).sin() + 0.3 * (i as f32 * 1.9).cos()).collect();
    let fast = fft.power_spectrum(&frame);
    let slow = naive_power_spectrum(&frame);
    for k in 0..fast.len() {
        assert!((fast[k] - slow[k]).abs() < 0.05 * slow[k].abs().max(1.0), "bin {k}: {} vs {}", fast[k], slow[k]);
    }
}

#[test]
fn log_mel_rejects_fft_sizes_that_arent_a_power_of_two() {
    assert!(create_fft(400).is_err());
}

#[test]
fn log_mel_produces_80_normalized_mels_per_10ms_frame() {
    let second: Vec<f32> = (0..16_000).map(|i| ((2.0 * std::f32::consts::PI * 440.0 * i as f32) / 16_000.0).sin()).collect();
    let mel = create_log_mel(PARAKEET_FEATURES).compute(&second);
    assert_eq!(mel.n_mels, PARAKEET_FEATURES.n_mels);
    assert_eq!(mel.frames, 1 + (16_000 - 400) / 160);
    let mean: f32 = mel.features[..mel.frames].iter().sum::<f32>() / mel.frames as f32;
    assert!(mean.abs() < 1e-4);
}

#[test]
fn log_mel_pads_a_clip_shorter_than_one_window() {
    assert_eq!(create_log_mel(PARAKEET_FEATURES).compute(&[0.0; 100]).frames, 1);
}

fn vocab() -> crate::engine::ctc::Vocabulary {
    parse_tokens("<unk> 0\n▁hel 1\nlo 2\n▁world 3\n. 4\n<blk> 5\n")
}

fn logprobs(path: &[usize]) -> Vec<f32> {
    let size = vocab().tokens.len();
    let mut data = vec![-10.0; path.len() * size];
    for (t, id) in path.iter().enumerate() {
        data[t * size + id] = 0.0;
    }
    data
}

#[test]
fn ctc_reads_sherpa_tokens_and_finds_the_blank() {
    let v = vocab();
    assert_eq!(v.tokens, ["<unk>", "▁hel", "lo", "▁world", ".", "<blk>"]);
    assert_eq!(v.blank_id, 5);
}

#[test]
fn ctc_collapses_repeats_drops_blanks_and_joins_pieces_into_words() {
    let path = [5, 1, 1, 5, 2, 2, 5, 3, 3, 3, 4, 5];
    assert_eq!(greedy_ctc(&logprobs(&path), path.len(), &vocab()), "hello world.");
}

#[test]
fn ctc_keeps_a_repeated_token_that_a_blank_separates() {
    let path = [2, 5, 2];
    assert_eq!(greedy_ctc(&logprobs(&path), path.len(), &vocab()), "lolo");
}

#[test]
fn ctc_drops_control_tokens() {
    let path = [0, 1, 2];
    assert_eq!(greedy_ctc(&logprobs(&path), path.len(), &vocab()), "hello");
}

/// A bundle of files as the TS test's fake fetcher served them: a missing
/// file answers with the SPA fallback page.
fn bundle(overrides: &[(&str, Option<Vec<u8>>)]) -> impl Fn(&str) -> anyhow::Result<Vec<u8>> {
    let chunks = [vec![1u8, 2, 3], vec![4u8, 5]];
    let tokens = b"<blk> 0\n".to_vec();
    let manifest = serde_json::json!({
        "version": "test-1",
        "size": 5,
        "chunks": chunks.iter().enumerate().map(|(i, c)| serde_json::json!({
            "file": format!("model.00{i}.bin"), "size": c.len(), "sha256": sha256_hex(c)
        })).collect::<Vec<_>>(),
        "tokens": { "file": "tokens.txt", "sha256": sha256_hex(&tokens) },
    });
    let mut files: std::collections::HashMap<String, Option<Vec<u8>>> = [
        ("manifest.json".to_string(), Some(manifest.to_string().into_bytes())),
        ("model.000.bin".to_string(), Some(chunks[0].clone())),
        ("model.001.bin".to_string(), Some(chunks[1].clone())),
        ("tokens.txt".to_string(), Some(tokens)),
    ]
    .into_iter()
    .collect();
    for (name, body) in overrides {
        files.insert(name.to_string(), body.clone());
    }
    move |file: &str| Ok(files.get(file).cloned().flatten().unwrap_or_else(|| b"<!doctype html>".to_vec()))
}

#[test]
fn load_model_joins_the_chunks_in_order_and_decodes_the_tokens() {
    let model = load_bundled_model(&bundle(&[])).unwrap();
    assert_eq!(model.bytes, [1, 2, 3, 4, 5]);
    assert_eq!(model.tokens, "<blk> 0\n");
    assert_eq!(model.version, "test-1");
}

#[test]
fn load_model_refuses_a_chunk_whose_checksum_doesnt_match() {
    let err = load_bundled_model(&bundle(&[("model.001.bin", Some(vec![4, 6]))])).unwrap_err();
    assert!(format!("{err:#}").contains("checksum mismatch"));
}

#[test]
fn load_model_refuses_the_spa_fallback_page_in_place_of_a_missing_chunk() {
    let err = load_bundled_model(&bundle(&[("model.000.bin", None)])).unwrap_err();
    assert!(format!("{err:#}").contains("bytes, expected"));
}

#[test]
fn load_model_reads_the_real_bundled_manifest_when_present() {
    // The TS app's bundled model, read in place (never copied). Skipped
    // where that checkout isn't next to this one.
    let dir = bundled_model_dir();
    if !dir.join("manifest.json").exists() {
        return;
    }
    let model = crate::engine::load_model::load_bundled_model_from_dir(&dir).unwrap();
    assert_eq!(model.bytes.len(), 131_652_171);
    assert!(parse_tokens(&model.tokens).tokens.len() > 100);
}

// ─── the local engine (worker-engine.test.ts) ──────────────────────────────

struct EchoModel {
    fail_next: Arc<Mutex<Option<String>>>,
}

impl SpeechModel for EchoModel {
    fn run(&mut self, _features: &[f32], _n_mels: usize, _frames: usize) -> anyhow::Result<(Vec<f32>, usize)> {
        if let Some(err) = self.fail_next.lock().unwrap().take() {
            anyhow::bail!(err);
        }
        // One frame whose best token is "hi".
        Ok((vec![0.0, -9.0], 1))
    }
}

struct EngineRig {
    exec: Rc<TestExecutor>,
    engine: Rc<LocalEngine>,
    built: Arc<AtomicUsize>,
    reads: Arc<AtomicUsize>,
    load_error: Arc<Mutex<Option<String>>>,
    fail_next: Arc<Mutex<Option<String>>>,
}

fn engine_rig() -> EngineRig {
    let exec = TestExecutor::new();
    let built = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let load_error: Arc<Mutex<Option<String>>> = Arc::default();
    let fail_next: Arc<Mutex<Option<String>>> = Arc::default();
    let (r, le) = (reads.clone(), load_error.clone());
    let source = ModelSource::Bundled(Box::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        if let Some(err) = le.lock().unwrap().clone() {
            anyhow::bail!(err);
        }
        Ok(crate::engine::load_model::BundledModel { version: "t".into(), bytes: vec![], tokens: "▁hi 0\n<blk> 1\n".into() })
    }));
    let (b, f) = (built.clone(), fail_next.clone());
    let factory: SpeechModelFactory = Arc::new(move |_| {
        b.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(EchoModel { fail_next: f.clone() }) as Box<dyn SpeechModel>)
    });
    let engine = Rc::new(create_local_engine(exec.clone(), source, factory));
    EngineRig { exec, engine, built, reads, load_error, fail_next }
}

#[test]
fn engine_loads_the_model_once_then_transcribes() {
    let rig = engine_rig();
    rig.exec.block_on(rig.engine.load()).unwrap();
    assert_eq!(rig.exec.block_on(rig.engine.transcribe(vec![0.0; 4])).unwrap(), "hi");
    rig.exec.block_on(rig.engine.load()).unwrap();
    assert_eq!(rig.built.load(Ordering::SeqCst), 1);
    assert_eq!(rig.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn engine_retries_a_failed_load_afresh() {
    let rig = engine_rig();
    *rig.load_error.lock().unwrap() = Some("chunk 3 failed its checksum".into());
    let err = rig.exec.block_on(rig.engine.load()).unwrap_err();
    assert!(err.to_string().contains("chunk 3 failed its checksum"));
    rig.load_error.lock().unwrap().take();
    assert_eq!(rig.exec.block_on(rig.engine.transcribe(vec![0.0; 4])).unwrap(), "hi");
    assert_eq!(rig.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn engine_keeps_the_model_after_a_call_that_merely_failed() {
    let rig = engine_rig();
    rig.exec.block_on(rig.engine.load()).unwrap();
    *rig.fail_next.lock().unwrap() = Some("bad audio".into());
    let err = rig.exec.block_on(rig.engine.transcribe(vec![0.0; 4])).unwrap_err();
    assert!(err.to_string().contains("bad audio"));
    assert_eq!(rig.exec.block_on(rig.engine.transcribe(vec![0.0; 4])).unwrap(), "hi");
    assert_eq!(rig.built.load(Ordering::SeqCst), 1);
}

#[test]
fn engine_without_a_backend_says_so() {
    let exec = TestExecutor::new();
    let source = ModelSource::Bundled(Box::new(|| {
        Ok(crate::engine::load_model::BundledModel { version: "t".into(), bytes: vec![], tokens: String::new() })
    }));
    let engine = Rc::new(create_local_engine(exec.clone(), source, unavailable_model()));
    let err = exec.block_on(engine.load()).unwrap_err();
    assert!(err.to_string().contains("isn't available in this build"));
}

// ─── the module ────────────────────────────────────────────────────────────

#[test]
fn registers_as_a_module_holding_right_ctrl() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<DictationModule>()]),
    )
    .unwrap();
    core.boot();
    let dictation = core.use_::<DictationModule>();
    assert_eq!(dictation.hold_key(), DictationHoldKey::ControlRight);
    assert_eq!(dictation.state().status, DictationStatus::Idle);
    // The delayed warm-up reads the settings and stays quiet when unused.
    exec.advance(Duration::from_secs(6));
    assert_eq!(dictation.state().status, DictationStatus::Idle);
    exec.block_on(core.dispose());
}

trait SpawnTest {
    fn spawn_local_test(&self, f: LocalBoxFuture<'static, ()>);
}

impl SpawnTest for Rc<TestExecutor> {
    fn spawn_local_test(&self, f: LocalBoxFuture<'static, ()>) {
        use notefig_core::Executor;
        self.spawn(f);
    }
}

// ─── the real model on recorded speech (`tests/e2e/dictation.spec.ts`) ─────

/// 16-bit mono PCM WAV → samples in [-1, 1].
fn read_wav_16k_mono(bytes: &[u8]) -> Vec<f32> {
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            return bytes[at + 8..(at + 8 + len).min(bytes.len())]
                .chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0)
                .collect();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk");
}

#[cfg(feature = "onnx")]
#[test]
fn transcribes_the_e2e_clip_with_the_bundled_model() {
    let dir = bundled_model_dir();
    let wav = dir.join("../../tests/e2e/fixtures/dictation.wav");
    if !dir.join("manifest.json").exists() || !wav.exists() {
        eprintln!("skipped: no bundled model or fixture at {}", dir.display());
        return;
    }
    let samples = read_wav_16k_mono(&std::fs::read(&wav).unwrap());
    let exec = TestExecutor::new();
    let engine = Rc::new(create_local_engine(exec.clone(), ModelSource::Dir(dir), speech_model()));
    exec.block_on(engine.load()).unwrap();
    let text = exec.block_on(engine.transcribe(samples.clone())).unwrap();
    eprintln!("transcript: {text}");
    // The TS e2e asserts the same words (its first word drifts: "Sip"/"Ship").
    assert!(text.to_lowercase().contains("dictation feature today"), "{text}");
    // Through the segmenter and phrase join, as a dictation hears it.
    let mut segmenter = crate::segmenter::create_segmenter(crate::segmenter::DEFAULT_SEGMENTER);
    let mut phrases: Vec<String> = Vec::new();
    for chunk in samples.chunks(640) {
        for phrase in segmenter.push(chunk) {
            phrases.push(exec.block_on(engine.transcribe(phrase)).unwrap());
        }
    }
    phrases.push(exec.block_on(engine.transcribe(segmenter.flush())).unwrap());
    assert!(join_phrases(&phrases).to_lowercase().contains("dictation feature today"));
}
