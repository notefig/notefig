//! The platform service: what the TS app calls `IPlatformAdapter`. Modules
//! take it with `ctx.service::<PlatformService>()` and never reach the OS
//! any other way; only the composition root picks an implementation
//! (`notefig-platform-native` on desktop, [`fake`] in tests, a browser one
//! later).
//!
//! Paths are absolute and native, as in the TS adapters.

use std::rc::Rc;

pub mod db;
pub mod fs;
pub mod updates;
pub mod ui;
#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use db::Db;
pub use fs::*;
pub use ui::{
    AppStatus, AppStatusAction, AppStatusActivate, AppStatusEntry, AppStatusSection, PlatformEvent, PlatformUi,
    TextPromptOptions,
};

/// `IPlatformAdapter`: one value with every surface.
#[derive(Clone)]
pub struct Platform {
    pub fs: Rc<dyn FileSystem>,
    pub db: Rc<dyn Db>,
    pub ui: Rc<dyn PlatformUi>,
    /// `updates`: the app's update channel.
    pub updates: Rc<dyn updates::PlatformUpdater>,
    /// Where the app keeps its own files (settings, the db, logs).
    pub app_data_dir: std::path::PathBuf,
}

/// The service a module lists in `needs` as `ModuleRef::service::<PlatformService>()`.
pub struct PlatformService;

impl notefig_core::Service for PlatformService {
    const NAME: &'static str = "platform";
    type Value = Platform;
}
