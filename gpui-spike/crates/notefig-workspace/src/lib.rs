//! Notefig workspace filesystem layer. No gpui: this crate is the seam
//! between the app and the disk (and later, a wasm/OPFS implementation).
//!
//! - [`Workspace`]: open a folder, walk it ([`Workspace::scan`]), read/write
//!   with content hashing, create/rename/delete (trash), path containment.
//! - [`Workspace::watch`]: `notify` watcher → batches of [`FsEvent`], with
//!   own-write echo suppression and rename pairing.
//! - [`state`]: app-state persistence as JSON.

pub mod rules;
pub mod scratchpads;
pub mod search;
pub mod state;
mod watch;
mod workspace;

pub use search::{SearchMatch, SearchOptions};
pub use state::{AppStateData, WindowBoundsState, RecentWorkspace, StateStore, ThemePreference, WorkspaceSession};
pub use watch::{FsEvent, WatchHandle, process as process_paths};
pub use workspace::{
    Entry, EntryKind, Tree, Workspace, content_hash, file_name, join_rel, parent_rel,
};
