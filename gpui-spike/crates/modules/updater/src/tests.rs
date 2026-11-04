//! Port of `components/__tests__/app-updater.test.ts`, plus the release
//! notes (`utils/release-notes.ts`, `use-release-notes-on-update.ts`, which
//! had no TS tests) and the bootstrap's timing.

use std::cell::RefCell;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use futures::stream::LocalBoxStream;
use notefig_core::testing::TestExecutor;
use notefig_kv::create_kv;
use notefig_platform::fake::FakePlatform;
use serde_json::{Value, json};

use crate::*;

#[derive(Default)]
struct MockUpdater {
    check: RefCell<Vec<UpdateCheckResult>>,
    checks: RefCell<usize>,
    apply: RefCell<Vec<UpdateApplyProgress>>,
    restart: RefCell<Option<UpdateRestartResult>>,
}

impl PlatformUpdater for MockUpdater {
    fn check(&self) -> LocalBoxFuture<'static, UpdateCheckResult> {
        *self.checks.borrow_mut() += 1;
        let next = self.check.borrow().first().cloned().unwrap_or(UpdateCheckResult::UpToDate { flow: UpdateFlow::DownloadRestart });
        futures::future::ready(next).boxed_local()
    }
    fn apply(&self) -> LocalBoxStream<'static, UpdateApplyProgress> {
        Box::pin(futures::stream::iter(self.apply.borrow().clone()))
    }
    fn restart(&self) -> LocalBoxFuture<'static, UpdateRestartResult> {
        futures::future::ready(self.restart.borrow().clone().unwrap_or(UpdateRestartResult::Restarted)).boxed_local()
    }
}

type Events = Rc<RefCell<Vec<(String, Value)>>>;

fn host(exec: &Rc<TestExecutor>, mock: Rc<MockUpdater>, auto: Option<bool>) -> (Rc<Updater>, Events) {
    let events: Events = Rc::default();
    let e = events.clone();
    let updater = create_updater(UpdaterDeps {
        updates: mock,
        executor: exec.clone(),
        capture: Rc::new(move |name, props| e.borrow_mut().push((name.to_string(), props))),
        auto_update_enabled: Rc::new(move || futures::future::ready(auto).boxed_local()),
    });
    (updater, events)
}

fn available_result() -> UpdateCheckResult {
    UpdateCheckResult::Available { flow: UpdateFlow::DownloadRestart, version: "1.2.3".into(), body: Some("notes".into()) }
}

/// A host whose last check found 1.2.3 (`hostWithAvailableUpdate`), with
/// settings not loaded so the check itself triggers nothing.
fn host_with_available_update(exec: &Rc<TestExecutor>, mock: Rc<MockUpdater>) -> (Rc<Updater>, Events) {
    mock.check.borrow_mut().push(available_result());
    let (updater, events) = host(exec, mock, None);
    exec.block_on(updater.check_for_update());
    (updater, events)
}

fn idle_install() -> InstallState {
    InstallState::default()
}

fn available() -> UpdateCheckData {
    UpdateCheckData {
        flow: UpdateFlow::DownloadRestart,
        update_info: Some(UpdateInfo { version: "1.2.3".into(), body: Some("notes".into()) }),
    }
}

fn check(data: Option<UpdateCheckData>, is_fetching: bool, is_error: bool) -> CheckState {
    CheckState { data, is_fetching, is_error }
}

// describe("deriveUpdaterView")

#[test]
fn is_idle_before_any_check_has_run() {
    assert_eq!(derive_updater_view(&check(None, false, false), &idle_install()).status, UpdaterStatus::Idle);
}

#[test]
fn is_checking_while_a_check_is_in_flight() {
    assert_eq!(derive_updater_view(&check(None, true, false), &idle_install()).status, UpdaterStatus::Checking);
}

#[test]
fn reports_an_available_update_with_its_info_and_flow() {
    let view = derive_updater_view(&check(Some(available()), false, false), &idle_install());
    assert_eq!(view.status, UpdaterStatus::Available);
    assert_eq!(view.update_info, Some(UpdateInfo { version: "1.2.3".into(), body: Some("notes".into()) }));
    assert_eq!(view.flow, UpdateFlow::DownloadRestart);
}

#[test]
fn is_up_to_date_when_the_check_returned_no_update() {
    let up_to_date = UpdateCheckData { flow: UpdateFlow::DownloadRestart, update_info: None };
    assert_eq!(derive_updater_view(&check(Some(up_to_date), false, false), &idle_install()).status, UpdaterStatus::UpToDate);
}

#[test]
fn surfaces_check_failures_as_an_error_with_a_message() {
    let view = derive_updater_view(&check(None, false, true), &idle_install());
    assert_eq!(view.status, UpdaterStatus::Error);
    assert!(view.error.is_some());
}

#[test]
fn a_downloading_install_wins_over_concurrent_check_activity() {
    let install = InstallState {
        phase: InstallPhase::Downloading,
        progress: UpdateProgress { downloaded: 50, total: Some(100) },
        error: None,
    };
    let view = derive_updater_view(&check(Some(available()), true, false), &install);
    assert_eq!(view.status, UpdaterStatus::Downloading);
    assert_eq!(view.progress, UpdateProgress { downloaded: 50, total: Some(100) });
}

#[test]
fn a_staged_ready_install_wins_over_check_results() {
    let install = InstallState { phase: InstallPhase::Ready, ..idle_install() };
    assert_eq!(derive_updater_view(&check(Some(available()), false, false), &install).status, UpdaterStatus::Ready);
}

#[test]
fn an_install_error_wins_and_carries_the_installs_message() {
    let install = InstallState { phase: InstallPhase::Error, error: Some("download failed".into()), ..idle_install() };
    let view = derive_updater_view(&check(Some(available()), false, false), &install);
    assert_eq!(view.status, UpdaterStatus::Error);
    assert_eq!(view.error.as_deref(), Some("download failed"));
}

// describe("resolveUpdateNotification")

fn base() -> NotificationInput {
    NotificationInput { auto_update_enabled: true, settings_ready: true, flow: UpdateFlow::DownloadRestart, install_active: false }
}

#[test]
fn auto_downloads_when_the_setting_is_on_for_the_download_restart_flow() {
    assert_eq!(resolve_update_notification(base()), UpdateNotificationAction::AutoDownload);
}

#[test]
fn prompts_when_the_setting_is_off() {
    assert_eq!(
        resolve_update_notification(NotificationInput { auto_update_enabled: false, ..base() }),
        UpdateNotificationAction::Prompt
    );
}

#[test]
fn prompts_for_the_refresh_flow_even_with_the_setting_on() {
    assert_eq!(
        resolve_update_notification(NotificationInput { flow: UpdateFlow::Refresh, ..base() }),
        UpdateNotificationAction::Prompt
    );
}

#[test]
fn defers_until_settings_have_loaded() {
    assert_eq!(
        resolve_update_notification(NotificationInput { settings_ready: false, ..base() }),
        UpdateNotificationAction::None
    );
}

#[test]
fn defers_while_an_install_is_already_in_flight() {
    assert_eq!(
        resolve_update_notification(NotificationInput { install_active: true, ..base() }),
        UpdateNotificationAction::None
    );
}

// describe("update telemetry")

#[test]
fn captures_started_and_completed_on_a_successful_download() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    *mock.apply.borrow_mut() =
        vec![UpdateApplyProgress::Downloading { downloaded: 10, total: Some(100) }, UpdateApplyProgress::Ready];
    let (updater, events) = host_with_available_update(&exec, mock);
    exec.block_on(updater.download_and_install(DownloadTrigger::Manual)).unwrap();
    let events = events.borrow();
    assert!(events.contains(&("update_download_started".into(), json!({"to_version": "1.2.3", "trigger": "manual"}))));
    assert!(events.contains(&("update_download_completed".into(), json!({"to_version": "1.2.3"}))));
    assert_eq!(updater.view().status, UpdaterStatus::Ready);
}

#[test]
fn tags_auto_triggered_downloads_in_telemetry() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    *mock.apply.borrow_mut() = vec![UpdateApplyProgress::Ready];
    let (updater, events) = host_with_available_update(&exec, mock);
    exec.block_on(updater.download_and_install(DownloadTrigger::Auto)).unwrap();
    assert!(events.borrow().contains(&("update_download_started".into(), json!({"to_version": "1.2.3", "trigger": "auto"}))));
}

#[test]
fn captures_update_failed_stage_download_when_the_download_errors() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    *mock.apply.borrow_mut() = vec![UpdateApplyProgress::Error { error: "x".into() }];
    let (updater, events) = host_with_available_update(&exec, mock);
    assert!(exec.block_on(updater.download_and_install(DownloadTrigger::Manual)).is_err());
    let events = events.borrow();
    assert!(events.contains(&("update_failed".into(), json!({"stage": "download", "to_version": "1.2.3"}))));
    assert!(!events.iter().any(|(n, _)| n == "update_download_completed"));
}

#[test]
fn captures_update_failed_stage_restart_when_relaunch_errors() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    *mock.restart.borrow_mut() = Some(UpdateRestartResult::Error { error: "x".into() });
    let (updater, events) = host_with_available_update(&exec, mock);
    exec.block_on(updater.relaunch());
    assert!(events.borrow().contains(&("update_failed".into(), json!({"stage": "restart", "to_version": "1.2.3"}))));
    assert_eq!(updater.view().status, UpdaterStatus::Error);
}

#[test]
fn falls_back_to_an_unknown_target_version_when_no_check_data_exists() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    *mock.restart.borrow_mut() = Some(UpdateRestartResult::Error { error: "x".into() });
    let (updater, events) = host(&exec, mock, None);
    exec.block_on(updater.relaunch());
    assert!(events.borrow().contains(&("update_failed".into(), json!({"stage": "restart", "to_version": "unknown"}))));
}

// The bootstrap (no TS test: it was a React effect).

#[test]
fn bootstrap_checks_now_and_every_fifteen_minutes() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    let (updater, _) = host(&exec, mock.clone(), Some(true));
    let sub = updater.start();
    exec.run_until_parked();
    assert_eq!(*mock.checks.borrow(), 1);
    assert_eq!(updater.view().status, UpdaterStatus::UpToDate);
    exec.advance(UPDATE_CHECK_INTERVAL);
    assert_eq!(*mock.checks.borrow(), 2);
    drop(sub);
    exec.advance(UPDATE_CHECK_INTERVAL * 2);
    assert!(*mock.checks.borrow() <= 3, "stopped");
}

#[test]
fn a_found_update_auto_downloads_then_offers_the_restart_once() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    mock.check.borrow_mut().push(available_result());
    *mock.apply.borrow_mut() = vec![UpdateApplyProgress::Ready];
    let (updater, events) = host(&exec, mock, Some(true));
    exec.block_on(updater.check_for_update());
    assert!(matches!(updater.notices()[..], [(_, UpdateNotice::ReadyToRestart)]));
    assert!(events.borrow().iter().any(|(n, _)| n == "update_available"));
    // A second check finding the same version stays quiet.
    let installs_before = updater.install_state();
    exec.block_on(updater.check_for_update());
    assert_eq!(updater.notices().len(), 1);
    assert_eq!(updater.install_state(), installs_before);
}

#[test]
fn with_auto_update_off_a_found_update_is_offered() {
    let exec = TestExecutor::new();
    let mock = Rc::new(MockUpdater::default());
    mock.check.borrow_mut().push(available_result());
    *mock.apply.borrow_mut() = vec![UpdateApplyProgress::Ready];
    let (updater, _) = host(&exec, mock, Some(false));
    exec.block_on(updater.check_for_update());
    assert_eq!(
        updater.notices()[0].1,
        UpdateNotice::Available { version: "1.2.3".into(), flow: UpdateFlow::DownloadRestart }
    );
    updater.start_download();
    exec.run_until_parked();
    let notices: Vec<_> = updater.notices().into_iter().map(|(_, n)| n).collect();
    assert_eq!(notices, vec![UpdateNotice::Downloaded, UpdateNotice::ReadyToRestart]);
}

#[test]
fn the_noop_backend_is_always_up_to_date() {
    let exec = TestExecutor::new();
    let updater = create_updater(UpdaterDeps {
        updates: Rc::new(NoopUpdater),
        executor: exec.clone(),
        capture: Rc::new(|_, _| {}),
        auto_update_enabled: Rc::new(|| futures::future::ready(Some(true)).boxed_local()),
    });
    exec.block_on(updater.check_for_update());
    assert_eq!(updater.view().status, UpdaterStatus::UpToDate);
}

// Release notes.

#[test]
fn a_titled_notes_file_names_itself() {
    let notes = release_notes("# Release Notes v0.0.152\n\n- Dictation.\n", "0.0.152");
    assert_eq!(notes.title.as_deref(), Some("Release Notes v0.0.152"));
    assert_eq!(notes.markdown, "# Release Notes v0.0.152\n\n- Dictation.");
    assert_eq!(notes.body, "- Dictation.");
}

#[test]
fn a_headingless_file_gets_the_version_title() {
    let notes = release_notes("- Fixed a thing.", "1.0.0");
    assert_eq!(notes.title.as_deref(), Some("Release Notes v1.0.0"));
    assert_eq!(notes.markdown, "# Release Notes v1.0.0\n\n- Fixed a thing.");
    assert_eq!(notes.body, "- Fixed a thing.");
}

#[test]
fn no_notes_is_empty() {
    let notes = release_notes("  \n", "1.0.0");
    assert_eq!(notes, ReleaseNotes { title: None, markdown: String::new(), body: String::new() });
    assert_eq!(release_notes("# Only a title", "1").body, "");
}

#[test]
fn release_notes_are_due_once_after_an_update_never_on_a_fresh_install() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = create_kv(fake.db.clone());
    assert!(!exec.block_on(release_notes_due(&kv, "1.0.0")), "fresh install: only records");
    assert!(!exec.block_on(release_notes_due(&kv, "1.0.0")), "same version");
    assert!(exec.block_on(release_notes_due(&kv, "1.1.0")), "updated");
    assert!(!exec.block_on(release_notes_due(&kv, "1.1.0")), "once");
    assert_eq!(fake.db.snapshot("kv:settings")["lastSeenVersion"], json!("1.1.0"));
}
