//! `components/app-updater.tsx` without React: the check query and the
//! install state become one observable [`Updater`]; `AppUpdaterBootstrap`'s
//! effect becomes [`Updater::start`]; toasts become [`UpdateNotice`]s a view
//! shows (the TS module called `sonner` directly).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::StreamExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, Listeners, Subscription};
use serde_json::{Value, json};

use crate::platform::{PlatformUpdater, UpdateApplyProgress, UpdateCheckResult, UpdateFlow, UpdateRestartResult};

/// How often to re-check while the app runs.
pub const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// Focus-triggered checks are skipped while the result is fresher than this.
pub const UPDATE_CHECK_STALE_TIME: Duration = Duration::from_secs(10 * 60);

/// `updaterGenericError`.
pub const GENERIC_ERROR: &str = "Something went wrong. Please try again.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterStatus {
    Idle,
    Checking,
    Available,
    UpToDate,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
}

/// `UpdateCheckData`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheckData {
    pub flow: UpdateFlow,
    pub update_info: Option<UpdateInfo>,
}

/// The check query's state, as `deriveUpdaterView` reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CheckState {
    pub data: Option<UpdateCheckData>,
    pub is_fetching: bool,
    pub is_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InstallPhase {
    #[default]
    Idle,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct InstallState {
    pub phase: InstallPhase,
    pub progress: UpdateProgress,
    pub error: Option<String>,
}

/// `AppUpdaterView`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppUpdaterView {
    pub status: UpdaterStatus,
    pub progress: UpdateProgress,
    pub error: Option<String>,
    pub update_info: Option<UpdateInfo>,
    pub flow: UpdateFlow,
}

/// `deriveUpdaterView`: install phases win over check activity.
pub fn derive_updater_view(check: &CheckState, install: &InstallState) -> AppUpdaterView {
    let update_info = check.data.as_ref().and_then(|d| d.update_info.clone());
    let flow = check.data.as_ref().map(|d| d.flow).unwrap_or_default();
    let view = |status, error| AppUpdaterView { status, progress: install.progress, error, update_info: update_info.clone(), flow };
    match install.phase {
        InstallPhase::Downloading => return view(UpdaterStatus::Downloading, None),
        InstallPhase::Ready => return view(UpdaterStatus::Ready, None),
        InstallPhase::Error => {
            return view(UpdaterStatus::Error, Some(install.error.clone().unwrap_or_else(|| GENERIC_ERROR.into())));
        }
        InstallPhase::Idle => {}
    }
    let status = if check.is_fetching {
        UpdaterStatus::Checking
    } else if check.is_error {
        UpdaterStatus::Error
    } else if update_info.is_some() {
        UpdaterStatus::Available
    } else if check.data.is_some() {
        UpdaterStatus::UpToDate
    } else {
        UpdaterStatus::Idle
    };
    view(status, (status == UpdaterStatus::Error).then(|| GENERIC_ERROR.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateNotificationAction {
    AutoDownload,
    Prompt,
    None,
}

#[derive(Debug, Clone, Copy)]
pub struct NotificationInput {
    pub auto_update_enabled: bool,
    pub settings_ready: bool,
    pub flow: UpdateFlow,
    pub install_active: bool,
}

/// `resolveUpdateNotification`.
pub fn resolve_update_notification(input: NotificationInput) -> UpdateNotificationAction {
    if !input.settings_ready || input.install_active {
        return UpdateNotificationAction::None;
    }
    if input.auto_update_enabled && input.flow == UpdateFlow::DownloadRestart {
        return UpdateNotificationAction::AutoDownload;
    }
    UpdateNotificationAction::Prompt
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadTrigger {
    Auto,
    Manual,
}

/// What the TS module toasted. Persistent ones (`Available`,
/// `ReadyToRestart`) stay until acted on or dismissed.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateNotice {
    /// `updaterToastAvailableTitle` with a Download / Refresh action.
    Available { version: String, flow: UpdateFlow },
    /// `toast.promise` loading.
    Downloading,
    /// `updaterToastDownloaded`.
    Downloaded,
    /// `updaterToastReadyToRestart` with a Restart action.
    ReadyToRestart,
    /// `updaterGenericError`.
    Failed,
}

/// The analytics sink (`captureEvent`).
pub type CaptureEvent = Rc<dyn Fn(&str, Value)>;

/// Where `autoUpdateEnabled` comes from; `None` until settings load.
pub type ReadAutoUpdate = Rc<dyn Fn() -> LocalBoxFuture<'static, Option<bool>>>;

pub struct UpdaterDeps {
    pub updates: Rc<dyn PlatformUpdater>,
    pub executor: Rc<dyn Executor>,
    pub capture: CaptureEvent,
    pub auto_update_enabled: ReadAutoUpdate,
}

/// The updater — `core.use_::<UpdaterModule>()`.
pub struct Updater {
    deps: UpdaterDeps,
    check: RefCell<CheckState>,
    install: RefCell<InstallState>,
    checked_at: Cell<Option<Instant>>,
    notices: RefCell<Vec<(u64, UpdateNotice)>>,
    next_notice: Cell<u64>,
    last_notified: RefCell<Option<String>>,
    release_notes_due: Cell<bool>,
    changed: Listeners<()>,
}

/// `createUpdater(deps)`.
pub fn create_updater(deps: UpdaterDeps) -> Rc<Updater> {
    Rc::new(Updater {
        deps,
        check: RefCell::default(),
        install: RefCell::default(),
        checked_at: Cell::new(None),
        notices: RefCell::default(),
        next_notice: Cell::new(0),
        last_notified: RefCell::new(None),
        release_notes_due: Cell::new(false),
        changed: Listeners::new(),
    })
}

impl Updater {
    /// `useAppUpdater()`'s value.
    pub fn view(&self) -> AppUpdaterView {
        derive_updater_view(&self.check.borrow(), &self.install.borrow())
    }

    pub fn check_state(&self) -> CheckState {
        self.check.borrow().clone()
    }

    pub fn install_state(&self) -> InstallState {
        self.install.borrow().clone()
    }

    /// The notices to show, oldest first, by id.
    pub fn notices(&self) -> Vec<(u64, UpdateNotice)> {
        self.notices.borrow().clone()
    }

    pub fn dismiss_notice(&self, id: u64) {
        self.notices.borrow_mut().retain(|(i, _)| *i != id);
        self.changed.emit();
    }

    /// Whether the release-notes tab is owed this launch; taking it clears
    /// it, so the shell opens the tab once even if it missed the hook.
    pub fn take_release_notes_due(&self) -> bool {
        self.release_notes_due.replace(false)
    }

    pub fn set_release_notes_due(&self) {
        self.release_notes_due.set(true);
        self.changed.emit();
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    /// Show a notice (what the module itself does on its own events;
    /// public for hosts and examples).
    pub fn push_notice(&self, notice: UpdateNotice) {
        self.notify(notice);
    }

    fn notify(&self, notice: UpdateNotice) {
        let id = self.next_notice.get();
        self.next_notice.set(id + 1);
        self.notices.borrow_mut().push((id, notice));
        self.changed.emit();
    }

    /// Replace transient download notices (the TS `toast.promise` id).
    fn clear_download_notices(&self) {
        self.notices
            .borrow_mut()
            .retain(|(_, n)| !matches!(n, UpdateNotice::Downloading | UpdateNotice::Downloaded | UpdateNotice::Failed));
    }

    fn patch_install(&self, patch: impl FnOnce(&mut InstallState)) {
        patch(&mut self.install.borrow_mut());
        self.changed.emit();
    }

    /// `isInstallActive`.
    pub fn install_active(&self) -> bool {
        matches!(self.install.borrow().phase, InstallPhase::Downloading | InstallPhase::Ready)
    }

    /// `pendingUpdateVersion`.
    fn pending_version(&self) -> String {
        self.check
            .borrow()
            .data
            .as_ref()
            .and_then(|d| d.update_info.as_ref())
            .map(|i| i.version.clone())
            .unwrap_or_else(|| "unknown".into())
    }

    /// `checkForUpdate` (`refetch`): a manual check runs even when a
    /// check is in flight it dedupes against. Resolves after any
    /// notification the result triggers has been decided.
    pub fn check_for_update(self: &Rc<Self>) -> LocalBoxFuture<'static, ()> {
        let this = self.clone();
        async move {
            if this.check.borrow().is_fetching {
                return;
            }
            this.check.borrow_mut().is_fetching = true;
            this.changed.emit();
            let result = this.deps.updates.check().await;
            {
                let mut check = this.check.borrow_mut();
                check.is_fetching = false;
                match result {
                    UpdateCheckResult::Error { error } => {
                        log::warn!("updater: check failed: {error}");
                        check.is_error = true;
                    }
                    UpdateCheckResult::Available { flow, version, body } => {
                        check.is_error = false;
                        check.data = Some(UpdateCheckData { flow, update_info: Some(UpdateInfo { version, body }) });
                    }
                    UpdateCheckResult::UpToDate { flow } => {
                        check.is_error = false;
                        check.data = Some(UpdateCheckData { flow, update_info: None });
                    }
                }
            }
            this.checked_at.set(Some(Instant::now()));
            this.changed.emit();
            this.react_to_check().await;
        }
        .boxed_local()
    }

    /// [`check_for_update`](Self::check_for_update), detached (a click).
    pub fn check_now(self: &Rc<Self>) {
        self.deps.executor.spawn(self.check_for_update());
    }

    /// [`relaunch`](Self::relaunch), detached (a click).
    pub fn relaunch_now(self: &Rc<Self>) {
        self.deps.executor.spawn(self.relaunch());
    }

    /// `refetchOnWindowFocus`, throttled by the stale time and paused
    /// while an install is underway.
    pub fn on_window_focus(self: &Rc<Self>) {
        if self.install_active() {
            return;
        }
        let fresh = self.checked_at.get().is_some_and(|at| at.elapsed() < UPDATE_CHECK_STALE_TIME);
        if !fresh {
            self.deps.executor.spawn(self.check_for_update());
        }
    }

    /// `AppUpdaterBootstrap`: check now, then every interval (paused while
    /// an install is active). The subscription stops the loop.
    pub fn start(self: &Rc<Self>) -> Subscription {
        let stopped = Rc::new(Cell::new(false));
        let this = Rc::downgrade(self);
        let executor = self.deps.executor.clone();
        let stop = stopped.clone();
        executor.clone().spawn(
            async move {
                loop {
                    if stop.get() {
                        return;
                    }
                    let Some(updater) = this.upgrade() else { return };
                    if !updater.install_active() {
                        updater.check_for_update().await;
                    }
                    drop(updater);
                    executor.timer(UPDATE_CHECK_INTERVAL).await;
                }
            }
            .boxed_local(),
        );
        Subscription::new(move || stopped.set(true))
    }

    /// The bootstrap's effect over a fresh check result.
    async fn react_to_check(self: &Rc<Self>) {
        let Some((flow, info)) = self
            .check
            .borrow()
            .data
            .as_ref()
            .and_then(|d| d.update_info.clone().map(|i| (d.flow, i)))
        else {
            return;
        };
        if self.last_notified.borrow().as_deref() == Some(info.version.as_str()) {
            return;
        }
        let auto = (self.deps.auto_update_enabled)().await;
        let action = resolve_update_notification(NotificationInput {
            auto_update_enabled: auto.unwrap_or(true),
            settings_ready: auto.is_some(),
            flow,
            install_active: self.install_active(),
        });
        if action == UpdateNotificationAction::None {
            return;
        }
        *self.last_notified.borrow_mut() = Some(info.version.clone());
        (self.deps.capture)("update_available", json!({ "to_version": info.version }));
        if action == UpdateNotificationAction::AutoDownload {
            // Silent; heard of once ready. A failure falls back to the prompt.
            match self.download_and_install(DownloadTrigger::Auto).await {
                Ok(()) => self.notify(UpdateNotice::ReadyToRestart),
                Err(_) => self.notify(UpdateNotice::Available { version: info.version, flow }),
            }
            return;
        }
        self.notify(UpdateNotice::Available { version: info.version, flow });
    }

    /// `downloadAndInstall`.
    pub fn download_and_install(self: &Rc<Self>, trigger: DownloadTrigger) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let this = self.clone();
        async move {
            let to_version = this.pending_version();
            let mut completed = false;
            let trigger = match trigger {
                DownloadTrigger::Auto => "auto",
                DownloadTrigger::Manual => "manual",
            };
            (this.deps.capture)("update_download_started", json!({ "to_version": to_version, "trigger": trigger }));
            this.patch_install(|s| {
                s.phase = InstallPhase::Downloading;
                s.error = None;
                s.progress = UpdateProgress::default();
            });
            let mut steps = this.deps.updates.apply();
            while let Some(step) = steps.next().await {
                match step {
                    UpdateApplyProgress::Downloading { downloaded, total } => this.patch_install(|s| {
                        s.phase = InstallPhase::Downloading;
                        s.error = None;
                        s.progress = UpdateProgress { downloaded, total };
                    }),
                    UpdateApplyProgress::Ready | UpdateApplyProgress::Applied => {
                        if !completed {
                            completed = true;
                            (this.deps.capture)("update_download_completed", json!({ "to_version": to_version }));
                        }
                        this.patch_install(|s| {
                            s.phase = InstallPhase::Ready;
                            s.error = None;
                        });
                    }
                    UpdateApplyProgress::Error { error } => {
                        log::warn!("updater: download failed: {error}");
                        (this.deps.capture)("update_failed", json!({ "stage": "download", "to_version": to_version }));
                        this.patch_install(|s| {
                            s.phase = InstallPhase::Error;
                            s.error = Some(GENERIC_ERROR.into());
                        });
                        anyhow::bail!(GENERIC_ERROR);
                    }
                }
            }
            Ok(())
        }
        .boxed_local()
    }

    /// `relaunchApp`.
    pub fn relaunch(self: &Rc<Self>) -> LocalBoxFuture<'static, ()> {
        let this = self.clone();
        async move {
            if let UpdateRestartResult::Error { error } = this.deps.updates.restart().await {
                log::warn!("updater: restart failed: {error}");
                (this.deps.capture)("update_failed", json!({ "stage": "restart", "to_version": this.pending_version() }));
                this.patch_install(|s| {
                    s.phase = InstallPhase::Error;
                    s.error = Some(GENERIC_ERROR.into());
                });
            }
        }
        .boxed_local()
    }

    /// `startDownloadWithToastPromise`: the refresh flow relaunches; the
    /// download flow shows progress, then offers the restart.
    pub fn start_download(self: &Rc<Self>) {
        let refresh = self.check.borrow().data.as_ref().is_some_and(|d| d.flow == UpdateFlow::Refresh);
        let this = self.clone();
        if refresh {
            self.deps.executor.spawn(async move { this.relaunch().await }.boxed_local());
            return;
        }
        // Acting on the offer settles it.
        self.notices.borrow_mut().retain(|(_, n)| !matches!(n, UpdateNotice::Available { .. }));
        self.notify(UpdateNotice::Downloading);
        self.deps.executor.spawn(
            async move {
                let result = this.download_and_install(DownloadTrigger::Manual).await;
                this.clear_download_notices();
                match result {
                    Ok(()) => {
                        this.notify(UpdateNotice::Downloaded);
                        this.notify(UpdateNotice::ReadyToRestart);
                    }
                    Err(_) => this.notify(UpdateNotice::Failed),
                }
            }
            .boxed_local(),
        );
    }
}
