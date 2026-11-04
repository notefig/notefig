//! The app updater: a port of `components/app-updater.tsx`'s state (the
//! check query, install state, `AppUpdaterBootstrap`), the
//! `PlatformUpdater` surface, `utils/release-notes.ts` and
//! `hooks/use-release-notes-on-update.ts`. Views live in
//! `notefig-view-updater`.
//!
//! Boot does what `AppUpdaterBootstrap` and `useReleaseNotesOnUpdate` did:
//! checks now and every 15 minutes, reacts to an update (auto-download or a
//! prompt notice), and announces [`ReleaseNotesDue`] once after the app
//! changed version, for the shell to open the release-notes tab
//! ([`RELEASE_NOTES_TAB_ID`]).

mod platform;
mod release_notes;
mod updater;

pub use platform::{
    NoopUpdater, PlatformUpdater, UpdateApplyProgress, UpdateCheckResult, UpdateFlow, UpdateRestartResult,
};
pub use release_notes::{
    APP_VERSION, LAST_SEEN_VERSION_KEY, RELEASE_NOTES_TAB_ID, ReleaseNotes, SETTINGS_NAMESPACE, latest_release_notes,
    release_notes, release_notes_due,
};
pub use updater::{
    AppUpdaterView, CaptureEvent, CheckState, DownloadTrigger, GENERIC_ERROR, InstallPhase, InstallState,
    NotificationInput, ReadAutoUpdate, UPDATE_CHECK_INTERVAL, UPDATE_CHECK_STALE_TIME, UpdateCheckData, UpdateInfo,
    UpdateNotice, UpdateNotificationAction, UpdateProgress, Updater, UpdaterDeps, UpdaterStatus, create_updater,
    derive_updater_view, resolve_update_notification,
};

use std::rc::Rc;

use futures::FutureExt;
use notefig_core::{ExecutorExt, Hook, Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::KvModule;
use notefig_platform::PlatformService;
use notefig_telemetry::TelemetryModule;

/// `"updater:release-notes-due"`: this launch is the first of a new
/// version; the shell opens the release-notes tab.
pub struct ReleaseNotesDue;

impl Hook for ReleaseNotesDue {
    const NAME: &'static str = "updater:release-notes-due";
    type Payload = String;
}

/// `updaterModule` (the TS had none: the updater lived in a React tree).
pub struct UpdaterModule;

impl Module for UpdaterModule {
    const NAME: &'static str = "updater";
    type Api = Rc<Updater>;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<KvModule>(), ModuleRef::of::<TelemetryModule>(), ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> Rc<Updater> {
        let kv = ctx.use_::<KvModule>();
        let telemetry = ctx.use_::<TelemetryModule>();
        create_updater(UpdaterDeps {
            updates: ctx.service::<PlatformService>().updates.clone(),
            executor: ctx.executor(),
            capture: Rc::new(move |name, props| telemetry.client().capture_event(name, Some(props))),
            auto_update_enabled: Rc::new(move || {
                let read = kv.read::<bool>(SETTINGS_NAMESPACE, "autoUpdateEnabled");
                async move { Some(read.await.unwrap_or(true)) }.boxed_local()
            }),
        })
    }

    fn boot(api: &Rc<Rc<Updater>>, ctx: &ModuleContext) -> Option<Subscription> {
        let kv = ctx.use_::<KvModule>();
        let hooks = ctx.hooks().clone();
        let due = release_notes_due(&kv, APP_VERSION);
        let updater = api.as_ref().clone();
        ctx.executor().spawn_local(async move {
            if due.await {
                updater.set_release_notes_due();
                hooks.emit::<ReleaseNotesDue>(APP_VERSION.to_string());
            }
        });
        Some(api.start())
    }
}

#[cfg(test)]
mod tests;
