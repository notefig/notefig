//! The desktop platform: what `adapters/tauri-adapter.ts` and `src-tauri`
//! give the TS app, in-process.
//!
//! - [`NativeFs`]: the fs on `std::fs`, walks with `ignore`, the `notify`
//!   watcher (debounced, own-write echo suppression, rename pairing), the
//!   OS trash, and ripgrep-style content search.
//! - [`SqliteDb`]: the persisted collections, one SQLite file.
//! - The ui surface needs GPUI (dialogs, the window), so it is not here:
//!   the app builds its `PlatformUi` in `crates/app` and hands it to
//!   [`native_platform`].
//!
//! Disk and CPU work runs on the executor's blocking pool; results land on
//! the main thread.

mod db;
mod fs;
pub mod rules;
mod search;
mod watch;

use std::path::PathBuf;
use std::rc::Rc;

pub use db::SqliteDb;
pub use fs::NativeFs;
use notefig_core::Executor;
use notefig_platform::{Platform, PlatformUi};

/// The desktop `Platform`: [`NativeFs`], [`SqliteDb`] at
/// `<app_data_dir>/notefig.db`, and the `ui` the app built. A db that
/// cannot open falls back to an in-memory one (logged), so the app still
/// starts.
pub fn native_platform(app_data_dir: PathBuf, executor: Rc<dyn Executor>, ui: Rc<dyn PlatformUi>) -> Platform {
    let db = SqliteDb::open(&app_data_dir.join("notefig.db"), executor.clone()).unwrap_or_else(|err| {
        log::error!("db: {err:#}; using an in-memory db for this run");
        SqliteDb::in_memory(executor.clone()).expect("in-memory sqlite")
    });
    Platform {
        fs: Rc::new(NativeFs::new(executor)),
        db: Rc::new(db),
        ui,
        // No update channel in this build yet.
        updates: Rc::new(notefig_platform::updates::NoopUpdater),
        app_data_dir,
    }
}

#[cfg(test)]
mod tests;
