//! The `files` module: a port of `packages/desktop/src/modules/files/`.
//!
//! Each open workspace's files are the module's workspace instance:
//! `core.workspace(ws).get::<FilesModule>()?` hands a [`WorkspaceFiles`].
//!
//! ## Reading
//! - [`WorkspaceFiles::metadata`]: every entry of the listing
//!   ([`FileMetadata`]: path, relative path, kind, mtime, size). Loads at
//!   open (the walk), re-walks every 30 s and on focus, follows the
//!   watcher. `get`, `rows`, `version`, `fetch_state`, `subscribe`.
//! - [`WorkspaceFiles::content`]: loaded files, on demand.
//!   [`WorkspaceFiles::open_file_rows`] is the open-tab join (asking loads);
//!   [`WorkspaceFiles::load_content`] loads explicitly.
//! - [`WorkspaceFiles::subscribe`]: either set changed.
//! - [`file_search`]: fuzzy file-name search over every open workspace
//!   (palette, mention picker), [`file_score`] the pure ranking.
//!
//! ## Writing — through a [`FileHandle`] (`files.file(path)`)
//! `create`, `create_directory`, `write`, `rename`, `delete` (to the
//! trash), `entry`, `prefetch`. Each resolves once disk has it; rows update
//! optimistically and roll back on failure.
//!
//! ## Announcing (hooks)
//! - [`FilesChanged`] `"files:changed"`: the watcher reported paths changed.
//! - [`GitStale`] `"git:stale"` and [`SearchStale`] `"search:stale"`: derived
//!   state is stale (debounced 500 ms after any write or change). `git:stale`
//!   is declared here, not in git, because git depends on files.
//!
//! ## Seams for other modules
//! - [`WorkspaceFiles::set_dirty_check`]: documents says which paths have a
//!   save in flight; a watcher content event for one is deferred.
//! - [`WorkspaceFiles::watch_content`]: the open tabs' paths.
//! - [`WorkspaceFiles::update_loaded_content`]: a write that bypassed files.
//! - [`WorkspaceFiles::record_disk_changes`]: rows for disk work done
//!   behind files' back (the scratchpad sweep).

mod collections;
pub mod file_score;
pub mod file_search;
mod files;
pub mod ignore;
pub mod paths;
mod sync;

pub use collections::{ContentCollection, FetchState, FileContent, FileMetadata, MetadataCollection};
pub use files::{FileEntry, FileHandle, FilesDeps, LISTING_FRESH, OpenFileRow, WorkspaceFiles, create_workspace_files};
pub use notefig_platform::EntryType;

use futures::FutureExt;
use notefig_core::{Hook, Module, ModuleContext, ModuleRef, Subscription, WorkspaceFocused, WorkspacePart};
use notefig_platform::PlatformService;

/// `files:changed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesChangedEvent {
    pub workspace_path: String,
    pub paths: Vec<String>,
}

/// The watcher reported changes in a workspace (created, deleted, renamed
/// or rewritten paths), already applied to its rows.
pub struct FilesChanged;
impl Hook for FilesChanged {
    const NAME: &'static str = "files:changed";
    type Payload = FilesChangedEvent;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEvent {
    pub workspace_path: String,
}

/// `git:stale`'s payload, under the name git and history use.
pub type GitStaleEvent = WorkspaceEvent;

/// The workspace's git rows are stale. The one declaration of
/// `"git:stale"`: files is the lowest crate that announces it (history and
/// git depend on files through agents → documents), so they re-export it
/// (`pub use notefig_files::{GitStale, GitStaleEvent}`) rather than declare
/// their own.
pub struct GitStale;
impl Hook for GitStale {
    const NAME: &'static str = "git:stale";
    type Payload = WorkspaceEvent;
}

/// The workspace's content-search results are stale (TS invalidates the
/// `["search-content", ws]` query).
pub struct SearchStale;
impl Hook for SearchStale {
    const NAME: &'static str = "search:stale";
    type Payload = WorkspaceEvent;
}

/// `filesModule`.
pub struct FilesModule;

impl Module for FilesModule {
    const NAME: &'static str = "files";
    type Api = ();
    type Workspace = WorkspaceFiles;

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(_: &ModuleContext) {}

    /// Coming back to a workspace re-walks its listing unless a walk is
    /// running or recent, and gives a failed watch another chance.
    fn boot(_: &std::rc::Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let ctx2 = ctx.clone();
        Some(ctx.hooks().on::<WorkspaceFocused, _>(move |ws| {
            // Closed while an earlier focus step ran: leave it alone.
            let handle = ctx2.workspace_handle(&ws.path);
            if !handle.is_open() {
                return;
            }
            if let Ok(files) = handle.get::<FilesModule>() {
                files.ensure_watching();
                ctx2.executor().spawn(files.catch_up(LISTING_FRESH).boxed_local());
            }
        }))
    }

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, _| {
                Ok(create_workspace_files(FilesDeps {
                    workspace_path: paths::normalize(&ctx.workspace().path),
                    fs: ctx.service::<PlatformService>().fs.clone(),
                    hooks: ctx.hooks().clone(),
                    executor: ctx.executor(),
                }))
            })
            .dispose(|files: std::rc::Rc<WorkspaceFiles>, _, _| {
                files.dispose();
                futures::future::ready(Ok(())).boxed_local()
            }),
        )
    }
}

#[cfg(test)]
mod tests;
