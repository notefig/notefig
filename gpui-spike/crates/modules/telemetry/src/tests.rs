//! Port of `src/telemetry/telemetry.test.ts` over a recording sink, plus the
//! module's consent flow over the fake platform's db.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_core::testing::TestExecutor;
use notefig_kv::create_kv;
use notefig_platform::fake::FakePlatform;
use serde_json::{Value, json};

use crate::*;

#[derive(Default)]
struct Recorder {
    inits: RefCell<Vec<String>>,
    events: RefCell<Vec<(String, Option<Value>)>>,
    errors: RefCell<Vec<String>>,
}

impl TelemetrySink for Recorder {
    fn init(&self, id: &str) {
        self.inits.borrow_mut().push(id.into());
    }
    fn capture(&self, name: &str, props: Option<&Value>) {
        self.events.borrow_mut().push((name.into(), props.cloned()));
    }
    fn capture_exception(&self, message: &str, _: Option<&Value>) {
        self.errors.borrow_mut().push(message.into());
    }
}

fn client(available: bool) -> (TelemetryClient, Rc<Recorder>) {
    let rec = Rc::new(Recorder::default());
    (create_telemetry_client(available, Some(rec.clone())), rec)
}

const ALL: TelemetryConsent = TelemetryConsent { crash_enabled: true, analytics_enabled: true };

#[test]
fn buffers_pre_consent_events_and_flushes_enabled_tiers_on_configure() {
    let (t, rec) = client(true);
    t.capture_event("workspace_opened", Some(json!({"is_new": false})));
    t.capture_error("Error: boom", None);
    assert!(rec.events.borrow().is_empty());
    t.configure(ALL, Some("id-1"));
    assert_eq!(rec.inits.borrow().len(), 1);
    assert_eq!(rec.events.borrow()[0], ("workspace_opened".into(), Some(json!({"is_new": false}))));
    assert_eq!(rec.errors.borrow().len(), 1);
}

#[test]
fn drops_buffered_usage_events_when_analytics_is_declined() {
    let (t, rec) = client(true);
    t.capture_event("workspace_opened", None);
    t.capture_error("Error: boom", None);
    t.configure(TelemetryConsent { crash_enabled: true, analytics_enabled: false }, Some("id-1"));
    assert!(rec.events.borrow().is_empty());
    assert_eq!(rec.errors.borrow().len(), 1);
}

#[test]
fn sends_nothing_and_never_inits_when_both_tiers_are_off() {
    let (t, rec) = client(true);
    t.capture_error("Error: boom", None);
    t.configure(TelemetryConsent::default(), None);
    t.capture_event("workspace_opened", None);
    assert!(rec.inits.borrow().is_empty() && rec.events.borrow().is_empty() && rec.errors.borrow().is_empty());
}

#[test]
fn is_fully_inert_without_a_build_time_key() {
    assert!(!telemetry_available());
    let (t, rec) = client(false);
    t.capture_error("Error: boom", None);
    t.configure(ALL, Some("id-1"));
    t.capture_event("workspace_opened", None);
    assert!(rec.inits.borrow().is_empty() && rec.events.borrow().is_empty() && rec.errors.borrow().is_empty());
}

#[test]
fn caps_the_pending_buffer() {
    let (t, rec) = client(true);
    for i in 0..40 {
        t.capture_event("settings_changed", Some(json!({"setting": format!("s{i}")})));
    }
    t.configure(TelemetryConsent { crash_enabled: false, analytics_enabled: true }, Some("id-1"));
    assert!(rec.events.borrow().len() <= 25);
}

#[test]
fn routes_consent_answered_when_only_crash_is_enabled() {
    let (t, rec) = client(true);
    t.configure(TelemetryConsent { crash_enabled: true, analytics_enabled: false }, Some("id-1"));
    t.capture_event("telemetry_consent_answered", None);
    assert_eq!(rec.events.borrow().len(), 1);
}

#[test]
fn stops_usage_events_after_a_live_opt_out() {
    let (t, rec) = client(true);
    t.configure(ALL, Some("id-1"));
    t.capture_event("workspace_opened", None);
    t.configure(TelemetryConsent { crash_enabled: true, analytics_enabled: false }, Some("id-1"));
    t.capture_event("workspace_opened", None);
    assert_eq!(rec.events.borrow().len(), 1);
}

#[test]
fn dedupes_the_same_error_within_the_window() {
    let (t, rec) = client(true);
    t.configure(ALL, Some("id-1"));
    t.capture_error("Error: same", None);
    t.capture_error("Error: same", None);
    assert_eq!(rec.errors.borrow().len(), 1);
}

#[test]
fn a_keyless_build_never_owes_consent_and_drops_everything() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = Rc::new(create_kv(fake.db.clone()));
    let (c, rec) = client(false);
    let t = create_telemetry(kv, c.clone(), exec.clone());
    t.start();
    exec.run_until_parked();
    assert!(!t.consent_owed());
    assert!(c.is_configured());
    c.capture_event("x", None);
    assert!(rec.events.borrow().is_empty());
}

#[test]
fn owes_consent_until_answered_then_persists_the_answer_with_the_marker_last() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = Rc::new(create_kv(fake.db.clone()));
    let (c, rec) = client(true);
    let t = create_telemetry(kv.clone(), c, exec.clone());
    let notified = Rc::new(RefCell::new(0));
    let n = notified.clone();
    let _sub = t.subscribe(move || *n.borrow_mut() += 1);
    t.start();
    exec.run_until_parked();
    assert!(t.consent_owed());
    t.answer(TelemetryConsent { crash_enabled: true, analytics_enabled: false });
    assert!(!t.consent_owed());
    exec.run_until_parked();
    assert_eq!(*notified.borrow(), 2);
    let rows = fake.db.snapshot("kv:settings");
    assert_eq!(rows["crashReportingEnabled"], json!(true));
    assert_eq!(rows["analyticsEnabled"], json!(false));
    assert_eq!(rows["telemetryConsentVersion"], json!(CURRENT_TELEMETRY_CONSENT_VERSION));
    assert!(rows["telemetryInstallId"].is_string());
    // Only the meta-tier answer passes with analytics off.
    let names: Vec<_> = rec.events.borrow().iter().map(|e| e.0.clone()).collect();
    assert_eq!(names, vec!["telemetry_consent_answered"]);
}

#[test]
fn a_stored_answer_configures_at_start_without_asking() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = Rc::new(create_kv(fake.db.clone()));
    exec.block_on(kv.write(SETTINGS_NAMESPACE, "telemetryConsentVersion", &1)).unwrap();
    exec.block_on(kv.write(SETTINGS_NAMESPACE, "analyticsEnabled", &true)).unwrap();
    let (c, rec) = client(true);
    let t = create_telemetry(kv, c, exec.clone());
    t.start();
    exec.run_until_parked();
    assert!(!t.consent_owed());
    assert_eq!(rec.events.borrow()[0].0, "app_opened");
    assert!(fake.db.snapshot("kv:settings")["telemetryInstallId"].is_string(), "an install id is minted once enabled");
}

#[test]
fn install_ids_are_uuid_shaped_and_distinct() {
    let (a, b) = (new_install_id(), new_install_id());
    assert_eq!(a.len(), 36);
    assert_eq!(&a[14..15], "4");
    assert_ne!(a, b);
}
