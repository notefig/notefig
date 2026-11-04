//! The app's status outside its window (the macOS menu-bar item): a port of
//! `hooks/use-app-status.ts` ([`derive_app_status`]), the Tauri adapter's
//! `publishAppStatus` (dedup + activations by id, [`AppStatusApi`]) and
//! the pure half of `src-tauri/src/app_status.rs` ([`model`]: entry text,
//! item ids, the glyph table). The drawing is `notefig-view-app-status`.
//!
//! The status goes to `platform.ui.publish_app_status` as in TS, and is also
//! kept here, observable ([`AppStatusApi::subscribe`] /
//! [`AppStatusApi::current`]), for the menu-bar presenter.

mod derive;
pub mod model;

use std::cell::RefCell;
use std::rc::Rc;

pub use derive::{
    APP_STATUS_ROWS, AppStatusHost, AppStatusInputs, Attention, AttentionItem, AttentionKind, AttentionTarget,
    DocumentRow, LABEL_CHARS, RoundRow, SessionRow, attention_mark, derive_app_status, describe_task_meta,
    project_name, task_mark, turn_mark,
};
pub use model::{
    AppStatus, AppStatusAction, AppStatusActivate, AppStatusEntry, AppStatusSection, activated_id, entry_text, glyph,
    item_id,
};

use notefig_core::{Listeners, Module, ModuleContext, ModuleRef, Subscription};
use notefig_platform::{Platform, PlatformService};

/// `core.appStatus`: the last published status and what its ids do.
pub struct AppStatusApi {
    platform: Option<Rc<Platform>>,
    current: RefCell<Option<AppStatus>>,
    changed: Listeners<()>,
}

/// `createAppStatus(platform)`; `None` publishes to nothing but listeners.
pub fn create_app_status(platform: Option<Rc<Platform>>) -> AppStatusApi {
    AppStatusApi {
        platform,
        current: RefCell::default(),
        changed: Listeners::new(),
    }
}

impl AppStatusApi {
    /// `ui.publishAppStatus`: cheap to call on any change — a status that
    /// draws the same as the last one costs nothing past swapping the
    /// callbacks.
    pub fn publish(&self, status: AppStatus) {
        // `AppStatus` compares without its callbacks: the newest callbacks
        // are kept either way, but only a change in what draws redraws.
        let same = self.current.borrow().as_ref() == Some(&status);
        *self.current.borrow_mut() = Some(status.clone());
        if same {
            return;
        }
        if let Some(platform) = &self.platform {
            platform.ui.publish_app_status(status);
        }
        self.changed.emit();
    }

    /// The status to draw, once one was published.
    pub fn current(&self) -> Option<AppStatus> {
        self.current.borrow().clone()
    }

    /// Fires when what to draw changed.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    /// The presenter's `app-status-activated`: run what `id` means. False
    /// for an id the last status didn't have.
    pub fn activate(&self, id: &str) -> bool {
        let current = self.current.borrow().clone();
        current.is_some_and(|status| status.activate(id))
    }
}

/// The module: `core.use_::<AppStatusModule>()`.
pub struct AppStatusModule;

impl Module for AppStatusModule {
    const NAME: &'static str = "app-status";
    type Api = AppStatusApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> AppStatusApi {
        create_app_status(Some(ctx.service::<PlatformService>()))
    }
}

#[cfg(test)]
mod tests;
